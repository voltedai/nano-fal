import { NanoSDK, NodeDefinition, NodeInstance, uploadAsset } from '@nanograph/sdk'
import { QueueStatus } from '@fal-ai/client'
import { configureFalClient, fal } from '../../utils/fal-client.js'
import { getParameterValue } from '../../utils/parameter-utils.js'
import { createSeedanceProgressStrategy } from './progress.js'
import { generateVideoFilename } from '../../utils/asset-utils.js'

interface SeedanceVideoResponse {
  data?: {
    video?: {
      url?: string
    }
    seed?: number
  }
}

const TEXT_ASPECT_RATIOS = ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16', '9:21'] as const
const PRO_TEXT_BLOCKED_RATIOS = new Set(['9:21'])
const VIDEO_RESOLUTIONS = ['480p', '720p', '1080p'] as const
const VIDEO_DURATIONS = ['3', '4', '5', '6', '7', '8', '9', '10', '11', '12'] as const

type TextAspectRatio = (typeof TEXT_ASPECT_RATIOS)[number]

type VideoResolution = (typeof VIDEO_RESOLUTIONS)[number]

type VideoDuration = (typeof VIDEO_DURATIONS)[number]

const ensureOption = <T extends string>(value: unknown, options: readonly T[], fallback: T): T => {
  if (typeof value === 'string' && options.includes(value as T)) {
    return value as T
  }
  return fallback
}

const nodeDefinition: NodeDefinition = {
  uid: 'fal-seedance-text-to-video',
  name: 'Seedance Text to Video',
  category: 'Seedance',
  version: '1.0.0',
  type: 'server',
  description: 'Generates videos from text prompts using Fal.ai Bytedance Seedance models',
  inputs: [
    {
      name: 'prompt',
      type: 'string',
      description: 'Text prompt describing the video to generate'
    }
  ],
  outputs: [
    {
      name: 'video',
      type: 'asset:video',
      description: 'Generated video as asset URI'
    },
    {
      name: 'seed',
      type: 'number',
      description: 'Seed returned by the API when deterministic generation is used'
    }
  ],
  parameters: [
    {
      name: 'model_variant',
      type: 'select',
      value: 'lite',
      default: 'lite',
      label: 'Model Variant',
      description: 'Choose Lite for faster results or Pro for higher fidelity',
      options: [
        { label: 'Lite (faster)', value: 'lite' },
        { label: 'Pro (higher quality)', value: 'pro' }
      ]
    },
    {
      name: 'aspect_ratio',
      type: 'select',
      value: '16:9',
      default: '16:9',
      label: 'Aspect Ratio',
      description: 'Aspect ratio of the generated video (9:21 available in Lite only)',
      options: [
        { label: '21:9 - Ultra Wide', value: '21:9' },
        { label: '16:9 - Widescreen', value: '16:9' },
        { label: '4:3 - Standard', value: '4:3' },
        { label: '1:1 - Square', value: '1:1' },
        { label: '3:4 - Portrait', value: '3:4' },
        { label: '9:16 - Vertical', value: '9:16' },
        { label: '9:21 - Tall Vertical (Lite)', value: '9:21' }
      ]
    },
    {
      name: 'resolution',
      type: 'select',
      value: '720p',
      default: '720p',
      label: 'Resolution',
      description: 'Rendering resolution (Pro defaults to 1080p)',
      options: [
        { label: '480p', value: '480p' },
        { label: '720p', value: '720p' },
        { label: '1080p', value: '1080p' }
      ]
    },
    {
      name: 'duration',
      type: 'select',
      value: '5',
      default: '5',
      label: 'Duration (seconds)',
      description: 'Clip duration in seconds',
      options: VIDEO_DURATIONS.map((value) => ({ label: `${value} seconds`, value }))
    },
    {
      name: 'camera_fixed',
      type: 'boolean',
      value: false,
      default: false,
      label: 'Lock Camera',
      description: 'Enable to keep the camera fixed throughout the clip'
    },
    {
      name: 'enable_safety_checker',
      type: 'boolean',
      value: true,
      default: true,
      label: 'Safety Checker',
      description: 'Toggle the Seedance safety checker'
    },
    {
      name: 'seed',
      type: 'number',
      value: -1,
      default: -1,
      label: 'Seed (-1 = random)',
      description: 'Use a fixed seed >= 0 for repeatable generations'
    }
  ]
}

const seedanceTextToVideoNode: NodeInstance = NanoSDK.registerNode(nodeDefinition)

seedanceTextToVideoNode.execute = async ({ inputs, parameters, context }) => {
  configureFalClient()

  const prompt = inputs.prompt?.[0] as string

  if (!prompt) {
    context.sendStatus({ type: 'error', message: 'Prompt is required' })
    throw new Error('Prompt is required')
  }

  const modelVariantRaw = getParameterValue<string>(parameters, 'model_variant', 'lite')
  const modelVariant = modelVariantRaw === 'pro' ? 'pro' : 'lite'

  const defaultResolution: VideoResolution = modelVariant === 'pro' ? '1080p' : '720p'
  const aspectRatioValue = getParameterValue<string>(parameters, 'aspect_ratio', '16:9')
  const resolutionValue = getParameterValue<string>(parameters, 'resolution', defaultResolution)
  const durationValue = getParameterValue<string>(parameters, 'duration', '5')
  const cameraFixedValue = getParameterValue<boolean>(parameters, 'camera_fixed', false)
  const safetyCheckerValue = getParameterValue<boolean>(parameters, 'enable_safety_checker', true)
  const seedValueRaw = getParameterValue<number>(parameters, 'seed', -1)

  const aspectRatio = ensureOption<TextAspectRatio>(aspectRatioValue, TEXT_ASPECT_RATIOS, '16:9')

  if (modelVariant === 'pro' && PRO_TEXT_BLOCKED_RATIOS.has(aspectRatio)) {
    const message = 'Aspect ratio 9:21 is only supported by the Lite variant'
    context.sendStatus({ type: 'error', message })
    throw new Error(message)
  }

  const resolution = ensureOption<VideoResolution>(resolutionValue, VIDEO_RESOLUTIONS, defaultResolution)
  const duration = ensureOption<VideoDuration>(durationValue, VIDEO_DURATIONS, '5')
  const camera_fixed = Boolean(cameraFixedValue)
  const enable_safety_checker = Boolean(safetyCheckerValue)
  const seedNumber = Number(seedValueRaw)

  const endpoint = modelVariant === 'pro'
    ? 'fal-ai/bytedance/seedance/v1/pro/text-to-video'
    : 'fal-ai/bytedance/seedance/v1/lite/text-to-video'

  const requestPayload: any = {
    prompt,
    aspect_ratio: aspectRatio,
    resolution,
    duration,
    camera_fixed,
    enable_safety_checker
  }

  if (Number.isInteger(seedNumber) && seedNumber >= 0) {
    requestPayload.seed = seedNumber
  }

  context.sendStatus({ type: 'running', message: 'Generating video with Seedance...' })

  try {
    let stepCount = 0
    const strategy = createSeedanceProgressStrategy({ durationSec: Number(duration), resolution })
    const result = await fal.subscribe(endpoint, {
      input: requestPayload,
      logs: true,
      onQueueUpdate: (status: QueueStatus) => {
        if (status.status === 'IN_QUEUE') {
          const r = strategy.onQueue()
          context.sendStatus({ type: 'running', message: r.message, progress: r.progress })
        } else if (status.status === 'IN_PROGRESS') {
          stepCount += 1
          const r = strategy.onProgress(status, stepCount)
          context.sendStatus({ type: 'running', message: r.message, progress: r.progress })
        } else if (status.status === 'COMPLETED') {
          const r = strategy.onCompleted()
          context.sendStatus({ type: 'running', message: r.message, progress: r.progress })
        }
      }
    }) as SeedanceVideoResponse

    const videoUrl = result.data?.video?.url

    if (!videoUrl) {
      throw new Error('No video was generated by Seedance')
    }

    const response = await fetch(videoUrl)
    const contentType = response.headers.get('content-type')
    const arrayBuffer = await response.arrayBuffer()
    const buffer = Buffer.from(arrayBuffer)

    const filename = generateVideoFilename(videoUrl, contentType)
    const uploadResult = await uploadAsset(buffer, { type: 'video', filename })

    if (!uploadResult?.uri) {
      throw new Error('Failed to upload generated video')
    }

    const seedOutput = typeof result.data?.seed === 'number' ? [result.data.seed] : []

    return {
      video: [uploadResult.uri],
      seed: seedOutput
    }
  } catch (error: any) {
    const message = error?.message || 'Failed to generate video'
    context.sendStatus({ type: 'error', message })
    throw error
  }
}

export default seedanceTextToVideoNode
