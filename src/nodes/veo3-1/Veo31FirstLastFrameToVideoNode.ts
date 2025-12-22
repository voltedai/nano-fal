import { NanoSDK, NodeDefinition, NodeInstance, resolveAsset, uploadAsset } from '@nanograph/sdk'
import { QueueStatus } from '@fal-ai/client'
import { configureFalClient, fal } from '../../utils/fal-client.js'
import { getParameterValue } from '../../utils/parameter-utils.js'
import { createProgressStrategy } from '../../utils/progress-strategy.js'
import { ensureOption, uploadBufferAsImageUrl } from './utils.js'
import { generateVideoFilename } from '../../utils/asset-utils.js'

interface Veo31FirstLastFrameResponse {
  data?: {
    video?: {
      url?: string
    }
  }
}

const ASPECT_RATIOS = ['auto', '16:9', '9:16', '1:1'] as const
const RESOLUTIONS = ['720p', '1080p'] as const
const DURATIONS = ['8s'] as const

const nodeDefinition: NodeDefinition = {
  uid: 'fal-veo31-first-last-frame-to-video',
  name: 'Veo 3.1 First & Last Frame to Video',
  category: 'Veo / Veo 3.1',
  version: '1.0.0',
  type: 'server',
  description: 'Interpolates a video between the first and last frame using Fal.ai Veo 3.1 models',
  inputs: [
    {
      name: 'prompt',
      type: 'string',
      description: 'Text prompt guiding the motion between the first and last frame'
    },
    {
      name: 'first_frame',
      type: 'asset:image',
      description: 'Asset URI for the video’s first frame'
    },
    {
      name: 'last_frame',
      type: 'asset:image',
      description: 'Asset URI for the video’s last frame'
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
      description: 'Choose Standard for highest fidelity or Fast for quicker renders',
      options: [
        { label: 'Standard (highest fidelity)', value: 'standard' },
        { label: 'Fast (quicker results)', value: 'fast' }
      ]
    },
    {
      name: 'aspect_ratio',
      type: 'select',
      value: 'auto',
      default: 'auto',
      label: 'Aspect Ratio',
      description: 'Aspect ratio of the generated video (auto matches the first frame)',
      options: [
        { label: 'Auto (match first frame)', value: 'auto' },
        { label: '16:9 - Widescreen', value: '16:9' },
        { label: '9:16 - Vertical', value: '9:16' },
        { label: '1:1 - Square', value: '1:1' }
      ]
    },
    {
      name: 'resolution',
      type: 'select',
      value: '720p',
      default: '720p',
      label: 'Resolution',
      description: 'Rendering resolution',
      options: [
        { label: '720p', value: '720p' },
        { label: '1080p', value: '1080p' }
      ]
    },
    {
      name: 'duration',
      type: 'select',
      value: '8s',
      default: '8s',
      label: 'Duration',
      description: 'Clip duration (currently fixed at 8 seconds)',
      options: [
        { label: '8 seconds', value: '8s' }
      ]
    },
    {
      name: 'generate_audio',
      type: 'boolean',
      value: true,
      default: true,
      label: 'Generate Audio',
      description: 'Include automatically generated audio narration in the output'
    }
  ]
}

const veo31FirstLastFrameToVideoNode: NodeInstance = NanoSDK.registerNode(nodeDefinition)

veo31FirstLastFrameToVideoNode.execute = async ({ inputs, parameters, context }) => {
  configureFalClient()

  const prompt = inputs.prompt?.[0] as string
  const firstFrameUri = inputs.first_frame?.[0] as string
  const lastFrameUri = inputs.last_frame?.[0] as string

  if (!prompt) {
    context.sendStatus({ type: 'error', message: 'Prompt is required' })
    throw new Error('Prompt is required')
  }

  if (!firstFrameUri) {
    context.sendStatus({ type: 'error', message: 'First frame image is required' })
    throw new Error('First frame image is required')
  }

  if (!lastFrameUri) {
    context.sendStatus({ type: 'error', message: 'Last frame image is required' })
    throw new Error('Last frame image is required')
  }

  const modelVariantRaw = getParameterValue<string>(parameters, 'model_variant', 'standard')
  const modelVariant = modelVariantRaw === 'fast' ? 'fast' : 'standard'

  const aspectRatioValue = getParameterValue<string>(parameters, 'aspect_ratio', 'auto')
  const resolutionValue = getParameterValue<string>(parameters, 'resolution', '720p')
  const durationValue = getParameterValue<string>(parameters, 'duration', '8s')
  const generateAudioValue = getParameterValue<boolean>(parameters, 'generate_audio', true)

  const aspect_ratio = ensureOption(aspectRatioValue, ASPECT_RATIOS, 'auto')
  const resolution = ensureOption(resolutionValue, RESOLUTIONS, '720p')
  const duration = ensureOption(durationValue, DURATIONS, '8s')
  const generate_audio = Boolean(generateAudioValue)

  context.sendStatus({ type: 'running', message: 'Preparing frames for Veo 3.1 interpolation...' })

  const [firstFrameBuffer, lastFrameBuffer] = await Promise.all([
    resolveAsset(firstFrameUri, { asBuffer: true }) as Promise<Buffer>,
    resolveAsset(lastFrameUri, { asBuffer: true }) as Promise<Buffer>
  ])

  const [firstFrameUrl, lastFrameUrl] = await Promise.all([
    uploadBufferAsImageUrl(firstFrameBuffer, 'veo31-first-frame'),
    uploadBufferAsImageUrl(lastFrameBuffer, 'veo31-last-frame')
  ])

  const endpoint = modelVariant === 'fast'
    ? 'fal-ai/veo3.1/fast/first-last-frame-to-video'
    : 'fal-ai/veo3.1/first-last-frame-to-video'

  const payload = {
    prompt,
    first_frame_url: firstFrameUrl,
    last_frame_url: lastFrameUrl,
    aspect_ratio,
    resolution,
    duration,
    generate_audio
  }

  try {
    let stepCount = 0
    let expectedMs = modelVariant === 'fast' ? 60000 : 120000
    if (resolution === '1080p') expectedMs += 30000
    if (generate_audio) expectedMs += 5000
    const strategy = createProgressStrategy({
      expectedMs,
      inQueueMessage: 'Waiting in queue...',
      finalizingMessage: 'Finalizing video...',
      defaultInProgressMessage: (n) => `Interpolating frame ${n}...`
    })

    const result = await fal.subscribe(endpoint, {
      input: payload,
      logs: true,
      onQueueUpdate: (status: QueueStatus) => {
        try {
          console.log('[Veo31FirstLastFrameToVideo] Queue update:', JSON.stringify(status))
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
    }) as Veo31FirstLastFrameResponse

    const videoUrl = result.data?.video?.url

    if (!videoUrl) {
      throw new Error('No video was generated by Veo 3.1')
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
    const message = error?.message || 'Failed to interpolate video'
    context.sendStatus({ type: 'error', message })
    throw error
  }
}

export default veo31FirstLastFrameToVideoNode
