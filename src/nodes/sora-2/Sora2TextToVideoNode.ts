import { NanoSDK, NodeDefinition, NodeInstance, uploadAsset } from '@nanograph/sdk'
import { QueueStatus } from '@fal-ai/client'
import { configureFalClient, fal } from '../../utils/fal-client.js'
import { getParameterValue } from '../../utils/parameter-utils.js'
import { createProgressStrategy } from '../../utils/progress-strategy.js'
import { generateVideoFilename } from '../../utils/asset-utils.js'

interface Sora2VideoResponse {
  video?: {
    url?: string
    content_type?: string
    file_size?: number
    duration?: number
    height?: number
    width?: number
    fps?: number
    num_frames?: number
  }
}

const ASPECT_RATIOS = ['16:9', '9:16'] as const
const DURATIONS = ['4', '8', '12'] as const
const RESOLUTIONS_STANDARD = ['720p'] as const
const RESOLUTIONS_PRO = ['720p', '1080p'] as const

const ensureOption = <T extends string | number>(value: unknown, options: readonly T[], fallback: T): T => {
  if (typeof value === typeof fallback && options.includes(value as T)) {
    return value as T
  }
  return fallback
}

const nodeDefinition: NodeDefinition = {
  uid: 'fal-sora-2-text-to-video',
  name: 'Sora 2 Text to Video',
  category: 'Sora / Sora 2',
  version: '1.0.0',
  type: 'server',
  description: 'Generates videos from text prompts using Fal.ai Sora 2 models',
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
    }
  ],
  parameters: [
    {
      name: 'model_variant',
      type: 'select',
      value: 'standard',
      default: 'standard',
      label: 'Model Variant',
      description: 'Choose Standard for faster results or Pro for higher fidelity',
      options: [
        { label: 'Standard (faster)', value: 'standard' },
        { label: 'Pro (higher quality)', value: 'pro' }
      ]
    },
    {
      name: 'resolution',
      type: 'select',
      value: '720p',
      default: '720p',
      label: 'Resolution',
      description: 'Resolution of the generated video (1080p available in Pro variant)',
      options: [
        { label: '720p', value: '720p' },
        { label: '1080p (Pro only)', value: '1080p' }
      ]
    },
    {
      name: 'aspect_ratio',
      type: 'select',
      value: '16:9',
      default: '16:9',
      label: 'Aspect Ratio',
      description: 'Aspect ratio of the generated video',
      options: [
        { label: '16:9 - Widescreen', value: '16:9' },
        { label: '9:16 - Vertical', value: '9:16' }
      ]
    },
    {
      name: 'duration',
      type: 'select',
      value: '4',
      default: '4',
      label: 'Duration (seconds)',
      description: 'Duration of the generated video in seconds',
      options: [
        { label: '4 seconds', value: '4' },
        { label: '8 seconds', value: '8' },
        { label: '12 seconds', value: '12' }
      ]
    },
    {
      name: 'api_key',
      type: 'text',
      value: '',
      default: '',
      label: 'OpenAI API Key',
      description: 'Optional OpenAI API key to avoid billing for this request'
    }
  ]
}

const sora2TextToVideoNode: NodeInstance = NanoSDK.registerNode(nodeDefinition)

sora2TextToVideoNode.execute = async ({ inputs, parameters, context }) => {
  configureFalClient()

  const prompt = inputs.prompt?.[0] as string

  if (!prompt) {
    context.sendStatus({ type: 'error', message: 'Prompt is required' })
    throw new Error('Prompt is required')
  }

  const modelVariantRaw = getParameterValue<string>(parameters, 'model_variant', 'standard')
  const modelVariant = modelVariantRaw === 'pro' ? 'pro' : 'standard'

  const resolutionValue = getParameterValue<string>(parameters, 'resolution', '720p')
  const aspectRatioValue = getParameterValue<string>(parameters, 'aspect_ratio', '16:9')
  const durationValue = getParameterValue<string>(parameters, 'duration', '4')
  const apiKeyValue = getParameterValue<string>(parameters, 'api_key', '')

  const resolution = modelVariant === 'pro'
    ? ensureOption(resolutionValue, RESOLUTIONS_PRO, '720p')
    : ensureOption(resolutionValue, RESOLUTIONS_STANDARD, '720p')

  // Validate resolution for model variant
  if (modelVariant === 'standard' && resolution === '1080p') {
    context.sendStatus({ type: 'error', message: '1080p resolution is only available in Pro variant' })
    throw new Error('1080p resolution is only available in Pro variant')
  }
  const aspect_ratio = ensureOption(aspectRatioValue, ASPECT_RATIOS, '16:9')
  const duration = ensureOption(durationValue, DURATIONS, '4')

  const endpoint = modelVariant === 'pro'
    ? 'fal-ai/sora-2/text-to-video/pro'
    : 'fal-ai/sora-2/text-to-video'

  const payload: any = {
    prompt,
    resolution,
    aspect_ratio,
    duration: Number(duration)
  }

  if (apiKeyValue && apiKeyValue.trim().length > 0) {
    payload.api_key = apiKeyValue.trim()
  }

  context.sendStatus({ type: 'running', message: 'Generating video with Sora 2...' })

  console.log(`[Sora2TextToVideo] Payload to ${endpoint}:`, JSON.stringify(payload, null, 2))

  try {
    let stepCount = 0
    const expectedMs = duration === '12' ? 180000 : duration === '8' ? 120000 : 90000
    const strategy = createProgressStrategy({
      expectedMs,
      inQueueMessage: 'Waiting in queue...',
      finalizingMessage: 'Finalizing video...',
      defaultInProgressMessage: (n) => `Processing step ${n}...`
    })

    const result = await fal.subscribe(endpoint, {
      input: payload,
      logs: true,
      onQueueUpdate: (status: QueueStatus) => {
        try {
          console.log(`[Sora2TextToVideo] Queue update:`, JSON.stringify(status, null, 2))
        } catch { }
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
    }) as Sora2VideoResponse

    console.log(`[Sora2TextToVideo] Final response:`, JSON.stringify(result, null, 2))

    const videoUrl = result.video?.url

    if (!videoUrl) {
      throw new Error('No video was generated by Sora 2')
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

    return {
      video: [uploadResult.uri]
    }
  } catch (error: any) {
    console.log(`[Sora2TextToVideo] Error details:`, JSON.stringify(error, null, 2))

    let message = error?.message || 'Failed to generate video'

    // Extract detailed error message from Fal API response
    if (error?.body?.detail && Array.isArray(error.body.detail)) {
      const errorDetails = error.body.detail.map((detail: any) => detail.msg).join('; ')
      message = errorDetails
    }

    context.sendStatus({ type: 'error', message })
    throw error
  }
}

export default sora2TextToVideoNode
