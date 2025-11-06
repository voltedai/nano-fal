import { NanoSDK, NodeDefinition, NodeInstance, uploadAsset } from '@nanograph/sdk'
import { QueueStatus } from '@fal-ai/client'
import { configureFalClient, fal } from '../../utils/fal-client.js'
import { getParameterValue } from '../../utils/parameter-utils.js'
import { createProgressStrategy } from '../../utils/progress-strategy.js'
import { generateVideoFilename } from '../../utils/asset-utils.js'

interface Veo3VideoResponse {
  data?: {
    video?: {
      url?: string
    }
    seed?: number
  }
}

const ASPECT_RATIOS = ['16:9', '9:16', '1:1'] as const
const DURATIONS = ['4s', '6s', '8s'] as const
const RESOLUTIONS = ['720p', '1080p'] as const

const ensureOption = <T extends string>(value: unknown, options: readonly T[], fallback: T): T => {
  if (typeof value === 'string' && options.includes(value as T)) {
    return value as T
  }
  return fallback
}

const nodeDefinition: NodeDefinition = {
  uid: 'fal-veo3-text-to-video',
  name: 'Veo 3 Text to Video',
  category: 'Video Generation',
  version: '1.0.0',
  type: 'server',
  description: 'Generates narrated videos from text prompts using Fal.ai Veo 3 models',
  inputs: [
    {
      name: 'prompt',
      type: 'string',
      description: 'Primary text prompt describing the video to generate'
    },
    {
      name: 'negative_prompt',
      type: 'string',
      description: 'Optional negative prompt to steer away from unwanted details',
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
      name: 'duration',
      type: 'select',
      value: '8s',
      default: '8s',
      label: 'Duration',
      description: 'Clip duration in seconds',
      options: [
        { label: '4 seconds', value: '4s' },
        { label: '6 seconds', value: '6s' },
        { label: '8 seconds', value: '8s' }
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
      description: 'Rendering resolution (1080p available in Standard variant)',
      options: [
        { label: '720p', value: '720p' },
        { label: '1080p', value: '1080p' }
      ]
    },
    {
      name: 'generate_audio',
      type: 'boolean',
      value: true,
      default: true,
      label: 'Generate Audio',
      description: 'Include automatically generated audio narration in the output'
    },
    {
      name: 'enhance_prompt',
      type: 'boolean',
      value: true,
      default: true,
      label: 'Enhance Prompt',
      description: 'Let Veo 3 enhance the prompt for richer video details'
    },
    {
      name: 'auto_fix',
      type: 'boolean',
      value: true,
      default: true,
      label: 'Auto Fix Prompt',
      description: 'Automatically adjust prompts that violate policy or validation checks'
    },
    {
      name: 'seed',
      type: 'number',
      value: -1,
      default: -1,
      label: 'Seed (-1 = random)',
      description: 'Use a non-negative seed for reproducible generations'
    }
  ]
}

const veo3TextToVideoNode: NodeInstance = NanoSDK.registerNode(nodeDefinition)

veo3TextToVideoNode.execute = async ({ inputs, parameters, context }) => {
  configureFalClient()

  const prompt = inputs.prompt?.[0] as string
  const negativePrompt = inputs.negative_prompt?.[0] as string | undefined

  if (!prompt) {
    context.sendStatus({ type: 'error', message: 'Prompt is required' })
    throw new Error('Prompt is required')
  }

  const modelVariantRaw = getParameterValue<string>(parameters, 'model_variant', 'standard')
  const modelVariant = modelVariantRaw === 'fast' ? 'fast' : 'standard'

  const durationValue = getParameterValue<string>(parameters, 'duration', '8s')
  const aspectRatioValue = getParameterValue<string>(parameters, 'aspect_ratio', '16:9')
  const resolutionValue = getParameterValue<string>(parameters, 'resolution', '720p')
  const generateAudioValue = getParameterValue<boolean>(parameters, 'generate_audio', true)
  const enhancePromptValue = getParameterValue<boolean>(parameters, 'enhance_prompt', true)
  const autoFixValue = getParameterValue<boolean>(parameters, 'auto_fix', true)
  const seedValueRaw = getParameterValue<number>(parameters, 'seed', -1)

  const duration = ensureOption(durationValue, DURATIONS, '8s')
  const aspect_ratio = ensureOption(aspectRatioValue, ASPECT_RATIOS, '16:9')
  const resolution = ensureOption(resolutionValue, RESOLUTIONS, '720p')
  const generate_audio = Boolean(generateAudioValue)
  const enhance_prompt = Boolean(enhancePromptValue)
  const auto_fix = Boolean(autoFixValue)

  const endpoint = modelVariant === 'fast'
    ? 'fal-ai/veo3/fast'
    : 'fal-ai/veo3'

  const payload: any = {
    prompt,
    duration,
    aspect_ratio,
    resolution,
    generate_audio,
    enhance_prompt,
    auto_fix
  }

  if (negativePrompt && negativePrompt.trim().length > 0) {
    payload.negative_prompt = negativePrompt
  }

  const seedNumber = Number(seedValueRaw)
  if (Number.isInteger(seedNumber) && seedNumber >= 0) {
    payload.seed = seedNumber
  }

  context.sendStatus({ type: 'running', message: 'Generating video with Veo 3...' })

  try {
    let stepCount = 0
    let expectedMs = modelVariant === 'fast' ? 60000 : 120000
    if (resolution === '1080p') expectedMs += 30000
    if (generate_audio) expectedMs += 5000
    const strategy = createProgressStrategy({
      expectedMs,
      inQueueMessage: 'Waiting in queue...',
      finalizingMessage: 'Finalizing video...',
      defaultInProgressMessage: (n) => `Processing step ${n}...`
    })
    const result = await fal.subscribe(endpoint, {
      // Fal client typings don't yet cover Veo3 extras like resolution/auto_fix
      input: payload,
      logs: true,
      onQueueUpdate: (status: QueueStatus) => {
        try {
          console.log('[Veo3TextToVideo] Queue update:', JSON.stringify(status))
        } catch {}
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
    }) as Veo3VideoResponse

    const videoUrl = result.data?.video?.url

    if (!videoUrl) {
      throw new Error('No video was generated by Veo 3')
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

export default veo3TextToVideoNode
