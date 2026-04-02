#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import {
  ensureDataDir,
  getAiSearchPriority,
  getAiProfile,
  getFirecrawlApiKey,
  getAiTimeoutMs,
  getRequestTimeoutMs,
  getRawSearchMaxResults,
  getRawProviderCredentialSource,
  getRawProviderApiKey,
  getRawSearchPriority,
  getSiteRule,
  loadConfig,
} from './lib/config.mjs'
import { loadSettings } from './lib/settings.mjs'
import {
  buildCacheKey,
  buildCacheMeta,
  getCachedEntry,
  loadCacheState,
  setCachedEntry,
} from './lib/cache.mjs'
import { fetchProviderUsageSnapshot } from './lib/provider-usage.mjs'
import {
  loadUsageState,
  noteProviderFailure,
  noteProviderSuccess,
  rankProviders,
  rememberPreferredRawProviders,
  saveUsageState,
  updateProviderState,
} from './lib/state.mjs'
import {
  getAvailableRawProviders,
  RAW_PROVIDER_CAPABILITIES,
  runRawSearch,
} from './lib/providers.mjs'
import {
  AI_PROVIDER_CAPABILITIES,
  getAvailableAiProviders,
  runAiSearch,
} from './lib/ai-providers.mjs'
import { crawlSite, getScrapeCapabilities, mapSite, scrapeUrls } from './lib/web-tools.mjs'
import { formatResponse } from './lib/formatter.mjs'
import { startAiCliWorker, stopAiCliWorker } from './lib/ai-cli-worker-host.mjs'

ensureDataDir()
startAiCliWorker({ cwd: process.cwd() })

const searchArgsSchema = z.object({
  keywords: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
  site: z.string().optional(),
  type: z.enum(['web', 'news', 'images']).optional(),
  github_type: z.enum(['repositories', 'code', 'issues']).optional().describe('GitHub search type (only used with github provider)'),
  maxResults: z.number().int().min(1).max(20).optional(),
})

const aiSearchArgsSchema = z.object({
  query: z.string().min(1),
  site: z.string().optional(),
  timeoutMs: z.number().int().min(1000).max(300000).optional(),
})

const scrapeArgsSchema = z.object({
  urls: z.array(z.string().url()).min(1),
})

const mapArgsSchema = z.object({
  url: z.string().url(),
  limit: z.number().int().min(1).max(200).optional(),
  sameDomainOnly: z.boolean().optional(),
  search: z.string().optional(),
})

const crawlArgsSchema = z.object({
  url: z.string().url(),
  maxPages: z.number().int().min(1).max(200).optional(),
  maxDepth: z.number().int().min(0).max(5).optional(),
  sameDomainOnly: z.boolean().optional(),
})

const batchItemSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('search'),
    keywords: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
    site: z.string().optional(),
    type: z.enum(['web', 'news', 'images']).optional(),
    github_type: z.enum(['repositories', 'code', 'issues']).optional(),
    maxResults: z.number().int().min(1).max(20).optional(),
  }),
  z.object({
    action: z.literal('ai_search'),
    query: z.string().min(1),
    site: z.string().optional(),
    timeoutMs: z.number().int().min(1000).max(300000).optional(),
  }),
  z.object({
    action: z.literal('scrape'),
    urls: z.array(z.string().url()).min(1),
  }),
  z.object({
    action: z.literal('map'),
    url: z.string().url(),
    limit: z.number().int().min(1).max(200).optional(),
    sameDomainOnly: z.boolean().optional(),
    search: z.string().optional(),
  }),
])

const batchArgsSchema = z.object({
  batch: z.array(batchItemSchema).min(1).max(10),
})

function jsonText(payload) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(payload, null, 2),
      },
    ],
  }
}

function formattedText(tool, payload) {
  const text = formatResponse(tool, payload)
  return {
    content: [{ type: 'text', text }],
  }
}

function buildInputSchema(zodSchema) {
  const jsonSchema = zodToJsonSchema(zodSchema, { target: 'openApi3' })
  delete jsonSchema.$schema
  return jsonSchema
}

function getSearchCacheTtlMs(type = 'web') {
  switch (type) {
    case 'news':
      return 20 * 60 * 1000
    case 'images':
      return 60 * 60 * 1000
    case 'web':
    default:
      return 30 * 60 * 1000
  }
}

function getAiSearchCacheTtlMs(site) {
  return site === 'x.com' ? 10 * 60 * 1000 : 20 * 60 * 1000
}

function getScrapeCacheTtlMs(isXRoute = false) {
  return isXRoute ? 10 * 60 * 1000 : 60 * 60 * 1000
}

function buildRuntimeEnv(config) {
  return {
    ...process.env,
    ...(getRawProviderApiKey(config, 'serper')
      ? { SERPER_API_KEY: getRawProviderApiKey(config, 'serper') }
      : {}),
    ...(getRawProviderApiKey(config, 'brave')
      ? { BRAVE_API_KEY: getRawProviderApiKey(config, 'brave') }
      : {}),
    ...(getRawProviderApiKey(config, 'perplexity')
      ? { PERPLEXITY_API_KEY: getRawProviderApiKey(config, 'perplexity') }
      : {}),
    ...(getFirecrawlApiKey(config)
      ? { FIRECRAWL_API_KEY: getFirecrawlApiKey(config) }
      : {}),
    ...(getRawProviderApiKey(config, 'tavily')
      ? { TAVILY_API_KEY: getRawProviderApiKey(config, 'tavily') }
      : {}),
    ...(getRawProviderApiKey(config, 'github')
      ? { GITHUB_TOKEN: getRawProviderApiKey(config, 'github') }
      : {}),
    ...(() => {
      const grokKey = getRawProviderApiKey(config, 'xai') || getAiProfile(config, 'grok')?.apiKey
      return grokKey
        ? { XAI_API_KEY: process.env.XAI_API_KEY || grokKey, GROK_API_KEY: process.env.GROK_API_KEY || grokKey }
        : {}
    })(),
  }
}

async function executeAiSearch({ query, site, timeoutMs, config, usageState }) {
  const cacheState = loadCacheState()
  const aiAvailable = await getAvailableAiProviders(config)
  const aiPriority = getAiSearchPriority(config)

  // Use priority chain for auto-selection
  const aiCandidates = aiPriority.filter(p => aiAvailable.includes(p))

  if (!aiCandidates.length) {
    return {
      success: false,
      error: 'No AI search provider is available.',
      availableProviders: aiAvailable,
      aiFailures: [],
    }
  }

  // Check cache (provider-independent: query+site based)
  const aiSearchCacheKey = buildCacheKey('ai_search', {
    query,
    site: site || null,
  })
  const cachedAiSearch = getCachedEntry(cacheState, aiSearchCacheKey)
  if (cachedAiSearch) {
    return {
      success: true,
      cached: true,
      payload: cachedAiSearch.payload,
      cacheMeta: buildCacheMeta(cachedAiSearch, true),
    }
  }

  // Try AI providers in priority order
  const aiFailures = []
  for (const candidate of aiCandidates) {
    const profile = getAiProfile(config, candidate)
    const resolvedModel = profile.model || null
    try {
      const response = await runAiSearch({
        query,
        provider: candidate,
        site,
        model: resolvedModel,
        profile,
        timeoutMs: timeoutMs || getAiTimeoutMs(config),
      })
      noteProviderSuccess(usageState, candidate, {
        lastCostUsdTicks: response.usage?.cost_in_usd_ticks || null,
      })
      const cachedEntry = setCachedEntry(
        cacheState,
        aiSearchCacheKey,
        {
          tool: 'ai_search',
          site: site || null,
          provider: candidate,
          model: resolvedModel,
          response,
        },
        getAiSearchCacheTtlMs(site),
      )
      return {
        success: true,
        cached: false,
        provider: candidate,
        model: resolvedModel,
        response,
        aiFailures: aiFailures.length ? aiFailures : undefined,
        cacheMeta: buildCacheMeta(cachedEntry, false),
      }
    } catch (error) {
      aiFailures.push({
        provider: candidate,
        error: error instanceof Error ? error.message : String(error),
      })
      noteProviderFailure(usageState, candidate, error instanceof Error ? error.message : String(error), 60000)
    }
  }

  // Cross-fallback: all AI providers failed → try raw search
  const runtimeEnv = buildRuntimeEnv(config)
  const rawAvailable = getAvailableRawProviders(runtimeEnv)
  const rawProviders = rankProviders(
    getRawSearchPriority(config).filter(p => rawAvailable.includes(p)),
    usageState,
    site,
  )

  if (rawProviders.length) {
    try {
      const rawResponse = await runRawSearch({
        keywords: query,
        providers: rawProviders,
        site,
        type: 'web',
        maxResults: getRawSearchMaxResults(config),
      })

      noteProviderSuccess(usageState, rawResponse.usedProvider, {
        lastCostUsdTicks: rawResponse.usage?.cost_in_usd_ticks || null,
      })
      for (const failure of rawResponse.failures || []) {
        noteProviderFailure(usageState, failure.provider, failure.error, 60000)
      }

      return {
        success: true,
        cached: false,
        fallbackSource: 'search',
        fallbackProvider: rawResponse.usedProvider || rawProviders[0],
        aiFailures,
        response: rawResponse,
      }
    } catch {
      // Raw fallback also failed
    }
  }

  return {
    success: false,
    error: `All AI providers failed: ${aiFailures.map(f => `${f.provider}: ${f.error}`).join(' | ')}`,
    aiFailures,
  }
}

function normalizeCacheUrl(url) {
  try {
    return new URL(url).toString()
  } catch {
    return String(url)
  }
}

async function writeStartupSnapshot() {
  const config = loadConfig()
  const usageState = loadUsageState()
  const runtimeEnv = buildRuntimeEnv(config)
  const rawProviders = getAvailableRawProviders(runtimeEnv)
  const aiProviders = await getAvailableAiProviders(config)
  const scrapeCapabilities = getScrapeCapabilities()

  for (const provider of rawProviders) {
    let usagePatch = null
    try {
      usagePatch = await fetchProviderUsageSnapshot(provider, runtimeEnv)
    } catch {
      usagePatch = null
    }

    updateProviderState(usageState, provider, {
      available: true,
      connection: 'api',
      source: getRawProviderCredentialSource(config, provider, process.env) || 'env',
      usageSupport: RAW_PROVIDER_CAPABILITIES[provider]?.usageSupport || null,
      ...(usagePatch || {}),
    })
  }

  for (const provider of aiProviders) {
    updateProviderState(usageState, provider, {
      available: true,
      connection:
        provider === 'grok' && getAiProfile(config, 'grok').apiKey
          ? 'api'
          : 'cli',
      source:
        provider === 'grok' && getAiProfile(config, 'grok').apiKey
          ? 'config'
          : 'binary',
      usageSupport: AI_PROVIDER_CAPABILITIES[provider]?.usageSupport || null,
    })
  }

  updateProviderState(usageState, 'readability', {
    available: scrapeCapabilities.readability,
    connection: 'builtin',
    source: 'local',
  })

  updateProviderState(usageState, 'puppeteer', {
    available: scrapeCapabilities.puppeteer,
    connection: 'local-browser',
    source: 'local',
  })

  updateProviderState(usageState, 'firecrawl-extractor', {
    available: scrapeCapabilities.firecrawl,
    connection: 'api',
    source: getRawProviderCredentialSource(config, 'firecrawl', process.env) || 'env',
  })
}

const toolDefinitions = [
  {
    name: 'search',
    description: 'Run raw web search. Providers are auto-selected based on configured priority. Use site and github_type to route to GitHub repositories, code, or issues.',
    inputSchema: buildInputSchema(searchArgsSchema),
    annotations: { title: 'Web Search (search)' },
  },
  {
    name: 'ai_search',
    description: 'Run AI search. Provider and model are auto-selected based on configured priority.',
    inputSchema: buildInputSchema(aiSearchArgsSchema),
    annotations: { title: 'AI Search (ai_search)' },
  },
  {
    name: 'scrape',
    description: 'Fetch and extract readable content from known URLs.',
    inputSchema: buildInputSchema(scrapeArgsSchema),
    annotations: { title: 'Web Scrape (scrape)' },
  },
  {
    name: 'map',
    description: 'Discover links from a page.',
    inputSchema: buildInputSchema(mapArgsSchema),
    annotations: { title: 'Link Discovery (map)' },
  },
  {
    name: 'crawl',
    description: 'Traverse links from a starting URL and collect page summaries.',
    inputSchema: buildInputSchema(crawlArgsSchema),
    annotations: { title: 'Multi-page Crawl (crawl)' },
  },
  {
    name: 'batch',
    description: 'Execute multiple search, ai_search, scrape, and map actions in a single request. Each item runs in parallel. Crawl is not supported in batch.',
    inputSchema: buildInputSchema(batchArgsSchema),
    annotations: { title: 'Batch Actions (batch)' },
  },
]

const bundledSettings = loadSettings()

const server = new Server(
  {
    name: 'trib-search',
    version: '0.0.6',
  },
  {
    capabilities: {
      tools: {},
    },
    instructions: bundledSettings,
  },
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: toolDefinitions,
}))

server.setRequestHandler(CallToolRequestSchema, async request => {
  const config = loadConfig()
  const usageState = loadUsageState()
  const cacheState = loadCacheState()
  const timeoutMs = getRequestTimeoutMs(config)

  switch (request.params.name) {
    case 'search': {
      let args
      try {
        args = searchArgsSchema.parse(request.params.arguments || {})
      } catch (e) {
        if (e instanceof z.ZodError) {
          return { content: [{ type: 'text', text: JSON.stringify({ error: 'Invalid arguments', details: e.errors }) }], isError: true }
        }
        throw e
      }
      const siteRule = args.site ? getSiteRule(config, args.site) : null
      if (siteRule?.search === 'xai.x_search') {
        const response = await runRawSearch({
          keywords: Array.isArray(args.keywords) ? args.keywords.join(' ') : args.keywords,
          providers: ['xai'],
          site: args.site,
          type: 'web',
          maxResults: args.maxResults || getRawSearchMaxResults(config),
        })
        noteProviderSuccess(usageState, 'xai', {
          lastCostUsdTicks: response.usage?.cost_in_usd_ticks || null,
        })
        saveUsageState(usageState)
        return formattedText('search', {
          tool: 'search',
          site: 'x.com',
          provider: 'xai',
          response,
        })
      }
      const runtimeEnv = buildRuntimeEnv(config)
      const available = getAvailableRawProviders(runtimeEnv)
      const providers = rankProviders(
        getRawSearchPriority(config).filter(provider => available.includes(provider)),
        usageState,
        args.site,
      )

      if (!providers.length) {
        return { ...jsonText({
          error: 'No raw search provider is available. Configure a rawSearch credential such as serper or firecrawl.',
          availableProviders: available,
        }), isError: true }
      }

      const searchCacheKey = buildCacheKey('search', {
        keywords: Array.isArray(args.keywords) ? [...args.keywords] : args.keywords,
        providers,
        site: args.site || null,
        type: args.type || 'web',
        github_type: args.github_type || null,
        maxResults: args.maxResults || getRawSearchMaxResults(config),
      })
      const cachedSearch = getCachedEntry(cacheState, searchCacheKey)
      if (cachedSearch) {
        return formattedText('search', {
          ...cachedSearch.payload,
          cache: buildCacheMeta(cachedSearch, true),
        })
      }

      try {
        const response = await runRawSearch({
          ...args,
          providers,
          maxResults: args.maxResults || getRawSearchMaxResults(config),
        })

        noteProviderSuccess(usageState, response.usedProvider, {
          lastCostUsdTicks: response.usage?.cost_in_usd_ticks || null,
        })
        for (const failure of response.failures || []) {
          noteProviderFailure(usageState, failure.provider, failure.error, 60000)
        }
        if (args.site) {
          rememberPreferredRawProviders(usageState, args.site, [response.usedProvider, ...providers.filter(item => item !== response.usedProvider)])
        }

        saveUsageState(usageState)
        const cachedEntry = setCachedEntry(
          cacheState,
          searchCacheKey,
          {
            tool: 'search',
            providers,
            response,
          },
          getSearchCacheTtlMs(args.type || 'web'),
        )
        return formattedText('search', {
          tool: 'search',
          providers,
          response,
          cache: buildCacheMeta(cachedEntry, false),
        })
      } catch (error) {
        for (const provider of providers) {
          noteProviderFailure(usageState, provider, error instanceof Error ? error.message : String(error), 60000)
        }
        saveUsageState(usageState)

        // Cross-fallback: raw search failed → try AI providers
        if (!siteRule) {
          const aiPriority = getAiSearchPriority(config)
          const aiAvailable = await getAvailableAiProviders(config)
          const aiCandidates = aiPriority.filter(p => aiAvailable.includes(p))
          const query = Array.isArray(args.keywords) ? args.keywords.join(' ') : args.keywords
          const aiFallbackFailures = []

          for (const aiProvider of aiCandidates) {
            try {
              const aiProfile = getAiProfile(config, aiProvider)
              const aiModel = aiProfile.model || null
              const aiResponse = await runAiSearch({
                query: args.site ? `${query} site:${args.site}` : query,
                provider: aiProvider,
                site: args.site,
                model: aiModel,
                profile: aiProfile,
                timeoutMs: getAiTimeoutMs(config),
              })
              noteProviderSuccess(usageState, aiProvider, {
                lastCostUsdTicks: aiResponse.usage?.cost_in_usd_ticks || null,
              })
              saveUsageState(usageState)
              return formattedText('search', {
                tool: 'search',
                fallbackSource: 'ai_search',
                fallbackProvider: aiProvider,
                fallbackModel: aiModel,
                rawFailures: providers.map(p => ({ provider: p })),
                aiFallbackFailures,
                response: aiResponse,
              })
            } catch (aiError) {
              aiFallbackFailures.push({
                provider: aiProvider,
                error: aiError instanceof Error ? aiError.message : String(aiError),
              })
              noteProviderFailure(usageState, aiProvider, aiError instanceof Error ? aiError.message : String(aiError), 60000)
            }
          }
          saveUsageState(usageState)
        }

        return { ...jsonText({
          tool: 'search',
          error: error instanceof Error ? error.message : String(error),
          providers,
        }), isError: true }
      }
    }

    case 'ai_search': {
      let args
      try {
        args = aiSearchArgsSchema.parse(request.params.arguments || {})
      } catch (e) {
        if (e instanceof z.ZodError) {
          return { content: [{ type: 'text', text: JSON.stringify({ error: 'Invalid arguments', details: e.errors }) }], isError: true }
        }
        throw e
      }

      const result = await executeAiSearch({
        query: args.query,
        site: args.site,
        timeoutMs: args.timeoutMs,
        config,
        usageState,
      })
      saveUsageState(usageState)

      if (!result.success) {
        return { ...jsonText({
          tool: 'ai_search',
          error: result.error,
          ...(result.availableProviders ? { availableProviders: result.availableProviders } : {}),
          ...(result.aiFailures?.length ? { aiFailures: result.aiFailures } : {}),
        }), isError: true }
      }

      if (result.cached) {
        return formattedText('ai_search', {
          ...result.payload,
          cache: result.cacheMeta,
        })
      }

      return formattedText('ai_search', {
        tool: 'ai_search',
        site: args.site || null,
        ...(result.fallbackSource ? { fallbackSource: result.fallbackSource, fallbackProvider: result.fallbackProvider } : { provider: result.provider, model: result.model }),
        response: result.response,
        ...(result.aiFailures ? { aiFailures: result.aiFailures } : {}),
        ...(result.cacheMeta ? { cache: result.cacheMeta } : {}),
      })
    }

    case 'scrape': {
      let args
      try {
        args = scrapeArgsSchema.parse(request.params.arguments || {})
      } catch (e) {
        if (e instanceof z.ZodError) {
          return { content: [{ type: 'text', text: JSON.stringify({ error: 'Invalid arguments', details: e.errors }) }], isError: true }
        }
        throw e
      }
      const normalizedUrls = args.urls.map(url => normalizeCacheUrl(url))

      if (args.urls.length === 1) {
        const host = new URL(args.urls[0]).host
        const siteRule = getSiteRule(config, host)
        if (siteRule?.scrape === 'xai.x_search') {
          const xScrapeCacheKey = buildCacheKey('scrape:x', {
            url: normalizedUrls[0],
          })
          const cachedXRoute = getCachedEntry(cacheState, xScrapeCacheKey)
          if (cachedXRoute) {
            return formattedText('scrape', {
              ...cachedXRoute.payload,
              cache: buildCacheMeta(cachedXRoute, true),
            })
          }
          const response = await runRawSearch({
            keywords: `Summarize the X post at ${args.urls[0]} and include the link.`,
            providers: ['xai'],
            site: 'x.com',
            type: 'web',
            maxResults: 3,
          })
          noteProviderSuccess(usageState, 'xai', {
            lastCostUsdTicks: response.usage?.cost_in_usd_ticks || null,
          })
          saveUsageState(usageState)
          const cachedEntry = setCachedEntry(
            cacheState,
            xScrapeCacheKey,
            {
              tool: 'scrape',
              url: args.urls[0],
              provider: 'xai',
              response,
            },
            getScrapeCacheTtlMs(true),
          )
          return formattedText('scrape', {
            tool: 'scrape',
            url: args.urls[0],
            provider: 'xai',
            response,
            cache: buildCacheMeta(cachedEntry, false),
          })
        }
      }

      const pageByUrl = new Map()
      const cacheByUrl = new Map()
      const missingUrls = []

      for (let index = 0; index < args.urls.length; index += 1) {
        const url = args.urls[index]
        const normalizedUrl = normalizedUrls[index]
        const scrapeCacheKey = buildCacheKey('scrape:url', {
          url: normalizedUrl,
        })
        const cachedPage = getCachedEntry(cacheState, scrapeCacheKey)
        if (cachedPage) {
          pageByUrl.set(normalizedUrl, cachedPage.payload.page)
          cacheByUrl.set(normalizedUrl, buildCacheMeta(cachedPage, true))
          continue
        }
        missingUrls.push({ url, normalizedUrl, scrapeCacheKey })
      }

      if (missingUrls.length > 0) {
        const fetchedPages = await scrapeUrls(
          missingUrls.map(item => item.url),
          timeoutMs,
          usageState,
        )

        fetchedPages.forEach((page, index) => {
          const target = missingUrls[index]
          if (page.error) {
            pageByUrl.set(target.normalizedUrl, page)
            return
          }
          const cachedEntry = setCachedEntry(
            cacheState,
            target.scrapeCacheKey,
            {
              page,
            },
            getScrapeCacheTtlMs(false),
          )
          pageByUrl.set(target.normalizedUrl, page)
          cacheByUrl.set(target.normalizedUrl, buildCacheMeta(cachedEntry, false))
        })
      }

      const pages = normalizedUrls.map(normalizedUrl => ({
        ...pageByUrl.get(normalizedUrl),
        cache: cacheByUrl.get(normalizedUrl) || null,
      }))
      updateProviderState(usageState, 'scrape', {
        lastUsedAt: new Date().toISOString(),
        lastSuccessAt: new Date().toISOString(),
      })
      saveUsageState(usageState)
      return formattedText('scrape', {
        tool: 'scrape',
        pages,
      })
    }

    case 'map': {
      let args
      try {
        args = mapArgsSchema.parse(request.params.arguments || {})
      } catch (e) {
        if (e instanceof z.ZodError) {
          return { content: [{ type: 'text', text: JSON.stringify({ error: 'Invalid arguments', details: e.errors }) }], isError: true }
        }
        throw e
      }
      const links = await mapSite(
        args.url,
        {
          limit: args.limit || 50,
          sameDomainOnly: args.sameDomainOnly ?? true,
          search: args.search,
        },
        timeoutMs,
      )
      return formattedText('map', {
        tool: 'map',
        links,
      })
    }

    case 'crawl': {
      let args
      try {
        args = crawlArgsSchema.parse(request.params.arguments || {})
      } catch (e) {
        if (e instanceof z.ZodError) {
          return { content: [{ type: 'text', text: JSON.stringify({ error: 'Invalid arguments', details: e.errors }) }], isError: true }
        }
        throw e
      }
      const pages = await crawlSite(
        args.url,
        {
          maxPages: args.maxPages || config.crawl?.maxPages || 10,
          maxDepth: args.maxDepth ?? config.crawl?.maxDepth ?? 1,
          sameDomainOnly: args.sameDomainOnly ?? config.crawl?.sameDomainOnly ?? true,
        },
        timeoutMs,
        usageState,
      )
      saveUsageState(usageState)
      return formattedText('crawl', {
        tool: 'crawl',
        pages,
      })
    }

    case 'batch': {
      let args
      try {
        args = batchArgsSchema.parse(request.params.arguments || {})
      } catch (e) {
        if (e instanceof z.ZodError) {
          return { content: [{ type: 'text', text: JSON.stringify({ error: 'Invalid arguments', details: e.errors }) }], isError: true }
        }
        throw e
      }

      const runtimeEnv = buildRuntimeEnv(config)

      const batchPromises = args.batch.map(async (item, idx) => {
        try {
          switch (item.action) {
            case 'search': {
              const siteRule = item.site ? getSiteRule(config, item.site) : null
              if (siteRule?.search === 'xai.x_search') {
                const response = await runRawSearch({
                  keywords: Array.isArray(item.keywords) ? item.keywords.join(' ') : item.keywords,
                  providers: ['xai'],
                  site: item.site,
                  type: 'web',
                  maxResults: item.maxResults || getRawSearchMaxResults(config),
                })
                noteProviderSuccess(usageState, 'xai', {
                  lastCostUsdTicks: response.usage?.cost_in_usd_ticks || null,
                })
                return { index: idx + 1, action: 'search', provider: 'xai', type: 'web', status: 'success', response }
              }

              const available = getAvailableRawProviders(runtimeEnv)
              const providers = rankProviders(
                getRawSearchPriority(config).filter(p => available.includes(p)),
                usageState,
                item.site,
              )

              if (!providers.length) {
                return { index: idx + 1, action: 'search', status: 'error', error: 'No raw search provider available' }
              }

              const searchCacheKey = buildCacheKey('search', {
                keywords: Array.isArray(item.keywords) ? [...item.keywords] : item.keywords,
                providers,
                site: item.site || null,
                type: item.type || 'web',
                github_type: item.github_type || null,
                maxResults: item.maxResults || getRawSearchMaxResults(config),
              })
              const cachedSearch = getCachedEntry(cacheState, searchCacheKey)
              if (cachedSearch) {
                return { index: idx + 1, action: 'search', status: 'success', ...cachedSearch.payload, cache: buildCacheMeta(cachedSearch, true) }
              }

              const response = await runRawSearch({
                ...item,
                providers,
                maxResults: item.maxResults || getRawSearchMaxResults(config),
              })

              noteProviderSuccess(usageState, response.usedProvider, {
                lastCostUsdTicks: response.usage?.cost_in_usd_ticks || null,
              })
              for (const failure of response.failures || []) {
                noteProviderFailure(usageState, failure.provider, failure.error, 60000)
              }

              setCachedEntry(cacheState, searchCacheKey, { tool: 'search', providers, response }, getSearchCacheTtlMs(item.type || 'web'))
              return { index: idx + 1, action: 'search', providers, status: 'success', response }
            }

            case 'ai_search': {
              const result = await executeAiSearch({
                query: item.query,
                site: item.site,
                timeoutMs: item.timeoutMs,
                config,
                usageState,
              })

              if (!result.success) {
                return { index: idx + 1, action: 'ai_search', status: 'error', error: result.error, ...(result.aiFailures?.length ? { aiFailures: result.aiFailures } : {}) }
              }

              if (result.cached) {
                return { index: idx + 1, action: 'ai_search', status: 'success', ...result.payload, cache: result.cacheMeta }
              }

              return {
                index: idx + 1,
                action: 'ai_search',
                status: 'success',
                ...(result.fallbackSource ? { fallbackSource: result.fallbackSource, fallbackProvider: result.fallbackProvider } : { provider: result.provider, model: result.model }),
                response: result.response,
                ...(result.aiFailures ? { aiFailures: result.aiFailures } : {}),
                ...(result.cacheMeta ? { cache: result.cacheMeta } : {}),
              }
            }

            case 'scrape': {
              const normalizedUrls = item.urls.map(u => normalizeCacheUrl(u))

              if (item.urls.length === 1) {
                const host = new URL(item.urls[0]).host
                const siteRule = getSiteRule(config, host)
                if (siteRule?.scrape === 'xai.x_search') {
                  const xCacheKey = buildCacheKey('scrape:x', { url: normalizedUrls[0] })
                  const cachedX = getCachedEntry(cacheState, xCacheKey)
                  if (cachedX) {
                    return { index: idx + 1, action: 'scrape', status: 'success', ...cachedX.payload, cache: buildCacheMeta(cachedX, true) }
                  }
                  const response = await runRawSearch({
                    keywords: `Summarize the X post at ${item.urls[0]} and include the link.`,
                    providers: ['xai'],
                    site: 'x.com',
                    type: 'web',
                    maxResults: 3,
                  })
                  noteProviderSuccess(usageState, 'xai', { lastCostUsdTicks: response.usage?.cost_in_usd_ticks || null })
                  setCachedEntry(cacheState, xCacheKey, { tool: 'scrape', url: item.urls[0], provider: 'xai', response }, getScrapeCacheTtlMs(true))
                  return { index: idx + 1, action: 'scrape', provider: 'xai', status: 'success', response }
                }
              }

              const pageByUrl = new Map()
              const cacheByUrl = new Map()
              const missingUrls = []

              for (let i = 0; i < item.urls.length; i += 1) {
                const url = item.urls[i]
                const normalizedUrl = normalizedUrls[i]
                const scrapeCacheKey = buildCacheKey('scrape:url', { url: normalizedUrl })
                const cachedPage = getCachedEntry(cacheState, scrapeCacheKey)
                if (cachedPage) {
                  pageByUrl.set(normalizedUrl, cachedPage.payload.page)
                  cacheByUrl.set(normalizedUrl, buildCacheMeta(cachedPage, true))
                  continue
                }
                missingUrls.push({ url, normalizedUrl, scrapeCacheKey })
              }

              if (missingUrls.length > 0) {
                const fetchedPages = await scrapeUrls(
                  missingUrls.map(m => m.url),
                  timeoutMs,
                  usageState,
                )
                fetchedPages.forEach((page, i) => {
                  const target = missingUrls[i]
                  if (page.error) {
                    pageByUrl.set(target.normalizedUrl, page)
                    return
                  }
                  const cachedEntry = setCachedEntry(cacheState, target.scrapeCacheKey, { page }, getScrapeCacheTtlMs(false))
                  pageByUrl.set(target.normalizedUrl, page)
                  cacheByUrl.set(target.normalizedUrl, buildCacheMeta(cachedEntry, false))
                })
              }

              const pages = normalizedUrls.map(nu => ({
                ...pageByUrl.get(nu),
                cache: cacheByUrl.get(nu) || null,
              }))
              return { index: idx + 1, action: 'scrape', status: 'success', pages }
            }

            case 'map': {
              const links = await mapSite(
                item.url,
                {
                  limit: item.limit || 50,
                  sameDomainOnly: item.sameDomainOnly ?? true,
                  search: item.search,
                },
                timeoutMs,
              )
              return { index: idx + 1, action: 'map', status: 'success', links }
            }

            default:
              return { index: idx + 1, action: item.action, status: 'error', error: `Unknown action: ${item.action}` }
          }
        } catch (error) {
          return { index: idx + 1, action: item.action, status: 'error', error: error instanceof Error ? error.message : String(error) }
        }
      })

      const settled = await Promise.allSettled(batchPromises)
      const results = settled.map((outcome, idx) => {
        if (outcome.status === 'fulfilled') return outcome.value
        return { index: idx + 1, action: args.batch[idx].action, status: 'error', error: outcome.reason?.message || String(outcome.reason) }
      })

      saveUsageState(usageState)
      return formattedText('batch', { tool: 'batch', results })
    }

    default:
      throw new Error(`Unknown tool: ${request.params.name}`)
  }
})

const transport = new StdioServerTransport()
await writeStartupSnapshot()
await server.connect(transport)

async function shutdown() {
  await stopAiCliWorker().catch(() => {})
  process.exit(0)
}

process.on('SIGTERM', () => { void shutdown() })
process.on('SIGINT', () => { void shutdown() })
