import Bluebird from "bluebird"
import fs from "fs-extra"
import reporter from "gatsby-cli/lib/reporter"
import { createErrorFromString } from "gatsby-cli/lib/reporter/errors"
import { chunk, truncate } from "lodash"
import { build, watch } from "../utils/webpack/bundle"
import * as path from "path"

import { emitter, store } from "../redux"
import { IWebpackWatchingPauseResume } from "../utils/start-server"
import webpackConfig from "../utils/webpack.config"
import { structureWebpackErrors } from "../utils/webpack-error-utils"
import * as buildUtils from "./build-utils"
import { getPageData } from "../utils/get-page-data"

import { Span } from "opentracing"
import { IProgram, Stage } from "./types"
import { ROUTES_DIRECTORY } from "../constants"
import { PackageJson } from "../.."
import { IPageDataWithQueryResult } from "../utils/page-data"
import { processNodeManifests } from "../utils/node-manifest"

import type { GatsbyWorkerPool } from "../utils/worker/pool"
import type webpack from "webpack"
type IActivity = any // TODO

export interface IBuildArgs extends IProgram {
  directory: string
  sitePackageJson: PackageJson
  prefixPaths: boolean
  noUglify: boolean
  logPages: boolean
  writeToFile: boolean
  profile: boolean
  graphqlTracing: boolean
  openTracingConfigFile: string
  // TODO remove in v4
  keepPageRenderer: boolean
}

interface IBuildRendererResult {
  rendererPath: string
  close: ReturnType<typeof watch>["close"]
}

let devssrWebpackCompiler: webpack.Watching | undefined
let needToRecompileSSRBundle = true
export const getDevSSRWebpack = (): {
  devssrWebpackWatcher: IWebpackWatchingPauseResume
  devssrWebpackCompiler: webpack.Compiler
  needToRecompileSSRBundle: boolean
} => {
  if (process.env.gatsby_executing_command !== `develop`) {
    throw new Error(`This function can only be called in development`)
  }

  return {
    devssrWebpackWatcher: devssrWebpackCompiler as webpack.Watching,
    devssrWebpackCompiler: (devssrWebpackCompiler as webpack.Watching).compiler,
    needToRecompileSSRBundle,
  }
}

let oldHash = ``
let newHash = ``
const runWebpack = (
  compilerConfig,
  stage: Stage,
  directory: string
): Promise<{
  stats: webpack.Stats
  close: ReturnType<typeof watch>["close"]
}> => {
  const isDevSSREnabledAndViable =
    process.env.GATSBY_EXPERIMENTAL_DEV_SSR && stage === `develop-html`

  return new Promise((resolve, reject) => {
    if (isDevSSREnabledAndViable) {
      const { watcher, close } = watch(
        compilerConfig,
        (err, stats) => {
          needToRecompileSSRBundle = false
          emitter.emit(`DEV_SSR_COMPILATION_DONE`)
          watcher.suspend()

          if (err) {
            return reject(err)
          } else {
            newHash = stats?.hash || ``

            const {
              restartWorker,
            } = require(`../utils/dev-ssr/render-dev-html`)
            // Make sure we use the latest version during development
            if (oldHash !== `` && newHash !== oldHash) {
              restartWorker(`${directory}/${ROUTES_DIRECTORY}render-page.js`)
            }

            oldHash = newHash

            return resolve({
              stats: stats as webpack.Stats,
              close,
            })
          }
        },
        {
          ignored: /node_modules/,
        }
      )
      devssrWebpackCompiler = watcher
    } else {
      build(compilerConfig).then(({ stats, close }) => {
        resolve({ stats, close })
      })
    }
  })
}

const doBuildRenderer = async (
  directory: string,
  webpackConfig: webpack.Configuration,
  stage: Stage
): Promise<IBuildRendererResult> => {
  const { stats, close } = await runWebpack(webpackConfig, stage, directory)
  if (stats?.hasErrors()) {
    reporter.panic(structureWebpackErrors(stage, stats.compilation.errors))
  }

  if (
    stage === `build-html` &&
    stats &&
    store.getState().html.ssrCompilationHash !== stats.hash
  ) {
    store.dispatch({
      type: `SET_SSR_WEBPACK_COMPILATION_HASH`,
      payload: stats.hash as string,
    })
  }

  // render-page.js is hard coded in webpack.config
  return {
    rendererPath: `${directory}/${ROUTES_DIRECTORY}render-page.js`,
    close,
  }
}

export const buildRenderer = async (
  program: IProgram,
  stage: Stage,
  parentSpan?: IActivity
): Promise<IBuildRendererResult> => {
  const config = await webpackConfig(program, program.directory, stage, null, {
    parentSpan,
  })

  return doBuildRenderer(program.directory, config, stage)
}

// TODO remove after v4 release and update cloud internals
export const deleteRenderer = async (rendererPath: string): Promise<void> => {
  try {
    await fs.remove(rendererPath)
    await fs.remove(`${rendererPath}.map`)
  } catch (e) {
    // This function will fail on Windows with no further consequences.
  }
}
export interface IRenderHtmlResult {
  unsafeBuiltinsUsageByPagePath: Record<string, Array<string>>
}

const renderHTMLQueue = async (
  workerPool: GatsbyWorkerPool,
  activity: IActivity,
  htmlComponentRendererPath: string,
  pages: Array<string>,
  stage: Stage = Stage.BuildHTML
): Promise<void> => {
  // We need to only pass env vars that are set programmatically in gatsby-cli
  // to child process. Other vars will be picked up from environment.
  const envVars: Array<[string, string | undefined]> = [
    [`NODE_ENV`, process.env.NODE_ENV],
    [`gatsby_executing_command`, process.env.gatsby_executing_command],
    [`gatsby_log_level`, process.env.gatsby_log_level],
  ]

  const segments = chunk(pages, 50)

  const sessionId = Date.now()

  const renderHTML =
    stage === `build-html`
      ? workerPool.single.renderHTMLProd
      : workerPool.single.renderHTMLDev

  const uniqueUnsafeBuiltinUsedStacks = new Set<string>()

  try {
    await Bluebird.map(segments, async pageSegment => {
      const renderHTMLResult = await renderHTML({
        envVars,
        htmlComponentRendererPath,
        paths: pageSegment,
        sessionId,
      })

      if (stage === `build-html`) {
        const htmlRenderMeta = renderHTMLResult as IRenderHtmlResult
        store.dispatch({
          type: `HTML_GENERATED`,
          payload: pageSegment,
        })

        for (const [_pagePath, arrayOfUsages] of Object.entries(
          htmlRenderMeta.unsafeBuiltinsUsageByPagePath
        )) {
          for (const unsafeUsageStack of arrayOfUsages) {
            uniqueUnsafeBuiltinUsedStacks.add(unsafeUsageStack)
          }
        }
      }

      if (activity && activity.tick) {
        activity.tick(pageSegment.length)
      }
    })
  } catch (e) {
    if (e?.context?.unsafeBuiltinsUsageByPagePath) {
      for (const [_pagePath, arrayOfUsages] of Object.entries(
        e.context.unsafeBuiltinsUsageByPagePath
      )) {
        // @ts-ignore TS doesn't know arrayOfUsages is Iterable
        for (const unsafeUsageStack of arrayOfUsages) {
          uniqueUnsafeBuiltinUsedStacks.add(unsafeUsageStack)
        }
      }
    }
    throw e
  } finally {
    if (uniqueUnsafeBuiltinUsedStacks.size > 0) {
      console.warn(
        `Unsafe builtin method was used, future builds will need to rebuild all pages`
      )
      store.dispatch({
        type: `SSR_USED_UNSAFE_BUILTIN`,
      })
    }

    for (const unsafeBuiltinUsedStack of uniqueUnsafeBuiltinUsedStacks) {
      const prettyError = await createErrorFromString(
        unsafeBuiltinUsedStack,
        `${htmlComponentRendererPath}.map`
      )

      const warningMessage = `${prettyError.stack}${
        prettyError.codeFrame ? `\n\n${prettyError.codeFrame}\n` : ``
      }`

      reporter.warn(warningMessage)
    }
  }
}

class BuildHTMLError extends Error {
  codeFrame = ``
  context?: {
    path: string
  }

  constructor(error: Error) {
    super(error.message)

    // We must use getOwnProperty because keys like `stack` are not enumerable,
    // but we want to copy over the entire error
    Object.getOwnPropertyNames(error).forEach(key => {
      this[key] = error[key]
    })
  }
}

const truncateObjStrings = (obj): IPageDataWithQueryResult => {
  // Recursively truncate strings nested in object
  // These objs can be quite large, but we want to preserve each field
  for (const key in obj) {
    if (typeof obj[key] === `object`) {
      truncateObjStrings(obj[key])
    } else if (typeof obj[key] === `string`) {
      obj[key] = truncate(obj[key], { length: 250 })
    }
  }

  return obj
}

export const doBuildPages = async (
  rendererPath: string,
  pagePaths: Array<string>,
  activity: IActivity,
  workerPool: GatsbyWorkerPool,
  stage: Stage
): Promise<void> => {
  try {
    await renderHTMLQueue(workerPool, activity, rendererPath, pagePaths, stage)
  } catch (error) {
    const prettyError = await createErrorFromString(
      error.stack,
      `${rendererPath}.map`
    )

    const buildError = new BuildHTMLError(prettyError)
    buildError.context = error.context

    if (error?.context?.path) {
      const pageData = await getPageData(error.context.path)
      const truncatedPageData = truncateObjStrings(pageData)

      const pageDataMessage = `Page data from page-data.json for the failed page "${
        error.context.path
      }": ${JSON.stringify(truncatedPageData, null, 2)}`

      reporter.error(pageDataMessage)
    }

    throw buildError
  }
}

// TODO remove in v4 - this could be a "public" api
export const buildHTML = async ({
  program,
  stage,
  pagePaths,
  activity,
  workerPool,
}: {
  program: IProgram
  stage: Stage
  pagePaths: Array<string>
  activity: IActivity
  workerPool: GatsbyWorkerPool
}): Promise<void> => {
  const { rendererPath } = await buildRenderer(program, stage, activity.span)
  await doBuildPages(rendererPath, pagePaths, activity, workerPool, stage)
}

export async function buildHTMLPagesAndDeleteStaleArtifacts({
  workerPool,
  buildSpan,
  program,
}: {
  workerPool: GatsbyWorkerPool
  buildSpan?: Span
  program: IBuildArgs
}): Promise<{
  toRegenerate: Array<string>
  toDelete: Array<string>
}> {
  const pageRenderer = `${program.directory}/${ROUTES_DIRECTORY}render-page.js`
  buildUtils.markHtmlDirtyIfResultOfUsedStaticQueryChanged()

  const { toRegenerate, toDelete, toCleanupFromTrackedState } =
    buildUtils.calcDirtyHtmlFiles(store.getState())

  store.dispatch({
    type: `HTML_TRACKED_PAGES_CLEANUP`,
    payload: toCleanupFromTrackedState,
  })

  if (toRegenerate.length > 0) {
    const buildHTMLActivityProgress = reporter.createProgress(
      `Building static HTML for pages`,
      toRegenerate.length,
      0,
      {
        parentSpan: buildSpan,
      }
    )
    buildHTMLActivityProgress.start()
    try {
      await doBuildPages(
        pageRenderer,
        toRegenerate,
        buildHTMLActivityProgress,
        workerPool,
        Stage.BuildHTML
      )
    } catch (err) {
      let id = `95313` // TODO: verify error IDs exist
      const context = {
        errorPath: err.context && err.context.path,
        ref: ``,
      }

      const match = err.message.match(
        /ReferenceError: (window|document|localStorage|navigator|alert|location) is not defined/i
      )
      if (match && match[1]) {
        id = `95312`
        context.ref = match[1]
      }

      buildHTMLActivityProgress.panic({
        id,
        context,
        error: err,
      })
    }
    buildHTMLActivityProgress.end()
  } else {
    reporter.info(`There are no new or changed html files to build.`)
  }

  if (_CFLAGS_.GATSBY_MAJOR !== `4` && !program.keepPageRenderer) {
    try {
      await deleteRenderer(pageRenderer)
    } catch (err) {
      // pass through
    }
  }

  if (toDelete.length > 0) {
    const publicDir = path.join(program.directory, `public`)
    const deletePageDataActivityTimer = reporter.activityTimer(
      `Delete previous page data`
    )
    deletePageDataActivityTimer.start()
    await buildUtils.removePageFiles(publicDir, toDelete)

    deletePageDataActivityTimer.end()
  }

  // we process node manifests in this location because we need to make sure all page-data.json files are written for gatsby as well as inc-builds (both call builHTMLPagesAndDeleteStaleArtifacts). Node manifests include a digest of the corresponding page-data.json file and at this point we can be sure page-data has been written out for the latest updates in gatsby build AND inc builds.
  await processNodeManifests()

  return { toRegenerate, toDelete }
}
