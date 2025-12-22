import { NanoSDK, NodeDefinition, NodeInstance, resolveAsset, uploadAsset } from '@nanograph/sdk'
import { QueueStatus } from '@fal-ai/client'
import { configureFalClient, fal } from '../../utils/fal-client.js'
import { getParameterValue } from '../../utils/parameter-utils.js'
import { createSeedanceProgressStrategy } from './progress.js'
import { uploadBufferToFal } from '../../utils/fal-storage.js'
import { generateVideoFilename } from '../../utils/asset-utils.js'

interface SeedanceVideoResponse {
  data?: {
    video?: {
      url?: string
    }
    seed?: number
  }
}

const IMAGE_ASPECT_RATIOS = ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16', 'auto', '9:21'] as const
const PRO_IMAGE_BLOCKED_RATIOS = new Set(['9:21'])
const VIDEO_RESOLUTIONS = ['480p', '720p', '1080p'] as const
const VIDEO_DURATIONS = ['3', '4', '5', '6', '7', '8', '9', '10', '11', '12'] as const

type ImageAspectRatio = (typeof IMAGE_ASPECT_RATIOS)[number]

type VideoResolution = (typeof VIDEO_RESOLUTIONS)[number]

type VideoDuration = (typeof VIDEO_DURATIONS)[number]

const ensureOption = <T extends string>(value: unknown, options: readonly T[], fallback: T): T => {
  if (typeof value === 'string' && options.includes(value as T)) {
    return value as T
  }
  return fallback
}

const detectImageMime = (buffer: Buffer): string => {
  const signature = buffer.slice(0, 12)

  if (signature.slice(0, 4).toString('hex') === '89504e47') {
    return 'png'
  }

  if (signature.slice(0, 3).toString('hex') === 'ffd8ff') {
    return 'jpeg'
  }

  if (signature.slice(0, 4).toString('hex') === '47494638') {
    return 'gif'
  }

  if (signature.slice(0, 4).toString('hex') === '424d') {
    return 'bmp'
  }

  if (
    signature.slice(0, 4).toString('ascii') === 'RIFF' &&
    signature.slice(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'webp'
  }

  return 'jpeg'
}

const uploadBufferAsImageUrl = async (buffer: Buffer, filenamePrefix: string): Promise<string> => {
  const format = detectImageMime(buffer)
  return uploadBufferToFal(buffer, format, { filenamePrefix })
}

const nodeDefinition: NodeDefinition = {
  uid: 'fal-seedance-image-to-video',
  name: 'Seedance Image to Video',
  category: 'Seedance',
  version: '1.0.0',
  type: 'server',
  description: 'Animates images into videos using Fal.ai Bytedance Seedance models',
  inputs: [
    {
      name: 'prompt',
      type: 'string',
      description: 'Text prompt providing motion guidance for the animation'
    },
    {
      name: 'image',
      type: 'asset:image',
      description: 'Primary reference image as asset URI'
    },
    {
      name: 'end_image',
      type: 'asset:image',
      description: 'Optional final frame image as asset URI',
      optional: true
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
      value: 'auto',
      default: 'auto',
      label: 'Aspect Ratio',
      description: 'Aspect ratio of the generated video (9:21 available in Lite only)',
      options: [
        { label: '21:9 - Ultra Wide', value: '21:9' },
        { label: '16:9 - Widescreen', value: '16:9' },
        { label: '4:3 - Standard', value: '4:3' },
        { label: '1:1 - Square', value: '1:1' },
        { label: '3:4 - Portrait', value: '3:4' },
        { label: '9:16 - Vertical', value: '9:16' },
        { label: 'Auto (match input)', value: 'auto' },
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

const seedanceImageToVideoNode: NodeInstance = NanoSDK.registerNode(nodeDefinition)

seedanceImageToVideoNode.execute = async ({ inputs, parameters, context }) => {
  configureFalClient()

  const prompt = inputs.prompt?.[0] as string
  const image = inputs.image?.[0] as string
  const endImage = inputs.end_image?.[0] as string | undefined

  if (!prompt) {
    context.sendStatus({ type: 'error', message: 'Prompt is required' })
    throw new Error('Prompt is required')
  }

  if (!image) {
    context.sendStatus({ type: 'error', message: 'Primary image is required' })
    throw new Error('Primary image is required')
  }

  const modelVariantRaw = getParameterValue<string>(parameters, 'model_variant', 'lite')
  const modelVariant = modelVariantRaw === 'pro' ? 'pro' : 'lite'
  const defaultResolution: VideoResolution = modelVariant === 'pro' ? '1080p' : '720p'
  const aspectRatioValue = getParameterValue<string>(parameters, 'aspect_ratio', 'auto')
  const resolutionValue = getParameterValue<string>(parameters, 'resolution', defaultResolution)
  const durationValue = getParameterValue<string>(parameters, 'duration', '5')
  const cameraFixedValue = getParameterValue<boolean>(parameters, 'camera_fixed', false)
  const safetyCheckerValue = getParameterValue<boolean>(parameters, 'enable_safety_checker', true)
  const seedValueRaw = getParameterValue<number>(parameters, 'seed', -1)

  const aspectRatio = ensureOption<ImageAspectRatio>(aspectRatioValue, IMAGE_ASPECT_RATIOS, 'auto')

  if (modelVariant === 'pro' && PRO_IMAGE_BLOCKED_RATIOS.has(aspectRatio)) {
    const message = 'Aspect ratio 9:21 is only supported by the Lite variant'
    context.sendStatus({ type: 'error', message })
    throw new Error(message)
  }

  const resolution = ensureOption<VideoResolution>(resolutionValue, VIDEO_RESOLUTIONS, defaultResolution)
  const duration = ensureOption<VideoDuration>(durationValue, VIDEO_DURATIONS, '5')
  const camera_fixed = Boolean(cameraFixedValue)
  const enable_safety_checker = Boolean(safetyCheckerValue)
  const seedNumber = Number(seedValueRaw)

  context.sendStatus({ type: 'running', message: 'Preparing Seedance request...' })

  try {
    const primaryImageBuffer: Buffer = await resolveAsset(image, { asBuffer: true }) as Buffer
    const primaryImageUrl = await uploadBufferAsImageUrl(primaryImageBuffer, 'seedance-primary')

    let endImageUrl: string | undefined
    if (endImage) {
      const endImageBuffer: Buffer = await resolveAsset(endImage, { asBuffer: true }) as Buffer
      endImageUrl = await uploadBufferAsImageUrl(endImageBuffer, 'seedance-end')
    }

    const endpoint = modelVariant === 'pro'
      ? 'fal-ai/bytedance/seedance/v1/pro/image-to-video'
      : 'fal-ai/bytedance/seedance/v1/lite/image-to-video'

    const requestPayload: any = {
      prompt,
      image_url: primaryImageUrl,
      aspect_ratio: aspectRatio,
      resolution,
      duration,
      camera_fixed,
      enable_safety_checker
    }

    if (endImageUrl) {
      requestPayload.end_image_url = endImageUrl
    }

    if (Number.isInteger(seedNumber) && seedNumber >= 0) {
      requestPayload.seed = seedNumber
    }

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
    const message = error?.message || 'Failed to animate image with Seedance'
    context.sendStatus({ type: 'error', message })
    throw error
  }
}

export default seedanceImageToVideoNode
