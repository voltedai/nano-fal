import { NanoSDK, NodeDefinition, NodeInstance } from '@nanograph/sdk'
import { QueueStatus } from '@fal-ai/client'
import { configureFalClient, fal } from '../../utils/fal-client.js'
import { createProgressStrategy } from '../../utils/progress-strategy.js'
import { getParameterValue } from '../../utils/parameter-utils.js'
import { FalImageReference, assetToDataUrl, uploadGeneratedImages } from '../flux-pro/utils.js'

interface Flux1KreaReduxResponse {
  images?: FalImageReference[]
  seed?: number
  has_nsfw_concepts?: boolean[]
  data?: {
    images?: FalImageReference[]
    seed?: number
    has_nsfw_concepts?: boolean[]
  }
}

const IMAGE_SIZE_PRESETS = [
  'landscape_4_3',
  'landscape_16_9',
  'portrait_4_3',
  'portrait_16_9',
  'square',
  'square_hd',
  'custom'
] as const

const IMAGE_SIZE_OPTIONS = [
  { label: 'Landscape 4:3 (default)', value: 'landscape_4_3' },
  { label: 'Landscape 16:9', value: 'landscape_16_9' },
  { label: 'Portrait 4:3', value: 'portrait_4_3' },
  { label: 'Portrait 16:9', value: 'portrait_16_9' },
  { label: 'Square', value: 'square' },
  { label: 'Square HD', value: 'square_hd' },
  { label: 'Custom (use width & height)', value: 'custom' }
] as const

const allowedFormats = new Set(['jpeg', 'png'])
const allowedAccelerations = new Set(['none', 'regular', 'high'])

const clampNumber = (value: number, min: number, max: number): number => {
  if (Number.isNaN(value)) {
    return min
  }
  return Math.min(Math.max(value, min), max)
}

const ensurePreset = (value: unknown): (typeof IMAGE_SIZE_PRESETS)[number] => {
  if (typeof value === 'string' && IMAGE_SIZE_PRESETS.includes(value as (typeof IMAGE_SIZE_PRESETS)[number])) {
    return value as (typeof IMAGE_SIZE_PRESETS)[number]
  }
  return 'landscape_4_3'
}

const nodeDefinition: NodeDefinition = {
  uid: 'fal-flux1-krea-redux',
  name: 'Flux-1 Krea Redux',
  category: 'Flux / Krea 1.1',
  version: '1.0.0',
  type: 'server',
  description: 'Upscales or refreshes images using Fal.ai\'s Flux-1 Krea Redux endpoint',
  inputs: [
    {
      name: 'image',
      type: 'asset:image',
      description: 'Source image asset to remix'
    },
    {
      name: 'prompt',
      type: 'string',
      description: 'Optional prompt guiding the redux transformation',
      optional: true
    }
  ],
  outputs: [
    {
      name: 'images',
      type: 'asset:image',
      description: 'Generated image variations as NanoGraph asset URIs'
    },
    {
      name: 'seed',
      type: 'number',
      description: 'Seed returned by the Flux-1 Krea API when provided'
    },
    {
      name: 'has_nsfw_concepts',
      type: 'boolean',
      description: 'NSFW flags reported per generated image'
    }
  ],
  parameters: [
    {
      name: 'num_images',
      type: 'number',
      value: 1,
      default: 1,
      min: 1,
      max: 4,
      step: 1,
      label: 'Number of Images',
      description: 'How many variations to generate (1-4)'
    },
    {
      name: 'image_size',
      type: 'select',
      value: 'landscape_4_3',
      default: 'landscape_4_3',
      label: 'Image Size Preset',
      description: 'Preset aspect ratios, or choose Custom to set explicit dimensions',
      options: IMAGE_SIZE_OPTIONS.map((option) => ({ label: option.label, value: option.value }))
    },
    {
      name: 'custom_width',
      type: 'number',
      value: 1024,
      default: 1024,
      min: 64,
      max: 14142,
      step: 1,
      label: 'Custom Width',
      description: 'Width in pixels when Image Size Preset is Custom'
    },
    {
      name: 'custom_height',
      type: 'number',
      value: 768,
      default: 768,
      min: 64,
      max: 14142,
      step: 1,
      label: 'Custom Height',
      description: 'Height in pixels when Image Size Preset is Custom'
    },
    {
      name: 'num_inference_steps',
      type: 'number',
      value: 28,
      default: 28,
      min: 1,
      max: 50,
      step: 1,
      label: 'Inference Steps',
      description: 'Number of denoising steps (1-50)'
    },
    {
      name: 'guidance_scale',
      type: 'number',
      value: 4.5,
      default: 4.5,
      min: 1,
      max: 20,
      step: 0.1,
      label: 'Guidance Scale (CFG)',
      description: 'How strongly the redux should follow guidance (1-20)'
    },
    {
      name: 'seed',
      type: 'number',
      value: -1,
      default: -1,
      min: -1,
      step: 1,
      label: 'Seed (-1 = random)',
      description: 'Use a fixed seed (>= 0) for repeatable variations'
    },
    {
      name: 'output_format',
      type: 'select',
      value: 'jpeg',
      default: 'jpeg',
      label: 'Output Format',
      description: 'Format for generated images',
      options: [
        { label: 'JPEG', value: 'jpeg' },
        { label: 'PNG', value: 'png' }
      ]
    },
    {
      name: 'acceleration',
      type: 'select',
      value: 'regular',
      default: 'regular',
      label: 'Acceleration',
      description: 'Generation speed profile (higher = faster)',
      options: [
        { label: 'None', value: 'none' },
        { label: 'Regular', value: 'regular' },
        { label: 'High', value: 'high' }
      ]
    },
    {
      name: 'sync_mode',
      type: 'boolean',
      value: false,
      default: false,
      label: 'Sync Mode',
      description: 'Wait for inline uploads before returning (adds latency)'
    },
    {
      name: 'enable_safety_checker',
      type: 'boolean',
      value: true,
      default: true,
      label: 'Enable Safety Checker',
      description: 'Toggle the Fal.ai safety checker'
    }
  ]
}

const flux1KreaReduxNode: NodeInstance = NanoSDK.registerNode(nodeDefinition)

flux1KreaReduxNode.execute = async ({ inputs, parameters, context }) => {
  configureFalClient()

  const imageUri = inputs.image?.[0] as string
  const prompt = inputs.prompt?.[0] as string | undefined

  if (!imageUri) {
    context.sendStatus({ type: 'error', message: 'An input image is required' })
    throw new Error('An input image is required')
  }

  context.sendStatus({ type: 'running', message: 'Preparing input image...' })

  const imageDataUrl = await assetToDataUrl(imageUri)

  const numImages = clampNumber(Number(getParameterValue(parameters, 'num_images', 1)), 1, 4)
  const imageSizePreset = ensurePreset(getParameterValue(parameters, 'image_size', 'landscape_4_3'))
  const customWidth = clampNumber(Math.round(Number(getParameterValue(parameters, 'custom_width', 1024))), 64, 14142)
  const customHeight = clampNumber(Math.round(Number(getParameterValue(parameters, 'custom_height', 768))), 64, 14142)
  const numInferenceSteps = clampNumber(Math.round(Number(getParameterValue(parameters, 'num_inference_steps', 28))), 1, 50)
  const guidanceScale = clampNumber(Number(getParameterValue(parameters, 'guidance_scale', 4.5)), 1, 20)
  const seedValue = Number(getParameterValue(parameters, 'seed', -1))
  const requestedFormat = String(getParameterValue(parameters, 'output_format', 'jpeg'))
  const outputFormat = allowedFormats.has(requestedFormat) ? requestedFormat : 'jpeg'
  const requestedAcceleration = String(getParameterValue(parameters, 'acceleration', 'regular'))
  const acceleration = allowedAccelerations.has(requestedAcceleration) ? requestedAcceleration : 'regular'
  const syncMode = Boolean(getParameterValue(parameters, 'sync_mode', false))
  const enableSafetyChecker = Boolean(getParameterValue(parameters, 'enable_safety_checker', true))

  const payload: Record<string, unknown> = {
    image_url: imageDataUrl,
    num_images: numImages,
    image_size: imageSizePreset === 'custom'
      ? { width: customWidth, height: customHeight }
      : imageSizePreset,
    num_inference_steps: numInferenceSteps,
    guidance_scale: guidanceScale,
    output_format: outputFormat,
    acceleration,
    sync_mode: syncMode,
    enable_safety_checker: enableSafetyChecker
  }

  if (prompt && prompt.trim().length > 0) {
    payload.prompt = prompt
  }

  if (Number.isInteger(seedValue) && seedValue >= 0) {
    payload.seed = seedValue
  }

  const accelerationFactor = acceleration === 'high' ? 0.65 : acceleration === 'regular' ? 0.85 : 1
  const syncFactor = syncMode ? 1.2 : 1
  const stepFactor = numInferenceSteps / 28
  const expectedMs = Math.min(
    150000,
    Math.max(16000, Math.floor(numImages * 26000 * stepFactor * accelerationFactor * syncFactor))
  )

  const strategy = createProgressStrategy({
    expectedMs,
    inQueueMessage: 'Waiting for Flux-1 Krea Redux...',
    finalizingMessage: 'Finalizing images...',
    defaultInProgressMessage: (step) => `Processing step ${step}...`
  })

  try {
    let stepCount = 0

    const result = await fal.subscribe('fal-ai/flux-1/krea/redux', {
      input: payload as any,
      logs: true,
      onQueueUpdate: (status: QueueStatus) => {
        if (status.status === 'IN_QUEUE') {
          const update = strategy.onQueue()
          context.sendStatus({ type: 'running', message: update.message, progress: update.progress })
        } else if (status.status === 'IN_PROGRESS') {
          stepCount += 1
          const update = strategy.onProgress(status, stepCount)
          context.sendStatus({ type: 'running', message: update.message, progress: update.progress })
        } else if (status.status === 'COMPLETED') {
          const update = strategy.onCompleted()
          context.sendStatus({ type: 'running', message: update.message, progress: update.progress })
        }
      }
    }) as Flux1KreaReduxResponse

    const responseData = (result as any)?.data ?? {}
    const directImages = Array.isArray(result.images) ? result.images : []
    const nestedImages = Array.isArray(responseData.images) ? responseData.images : []
    const images = (directImages.length ? directImages : nestedImages) as FalImageReference[]

    if (!images.length) {
      throw new Error('No images were returned by the Flux-1 Krea Redux API')
    }

    const uploadedImages = await uploadGeneratedImages(images)

    const responseSeed = typeof responseData.seed === 'number'
      ? responseData.seed
      : (typeof result.seed === 'number' ? result.seed : undefined)

    const nsfwFlags = Array.isArray(responseData.has_nsfw_concepts)
      ? responseData.has_nsfw_concepts
      : (Array.isArray(result.has_nsfw_concepts) ? result.has_nsfw_concepts : [])

    return {
      images: uploadedImages,
      seed: typeof responseSeed === 'number' ? [responseSeed] : [],
      has_nsfw_concepts: nsfwFlags
    }
  } catch (error: any) {
    const message = error?.message || 'Failed to run Flux-1 Krea Redux'
    context.sendStatus({ type: 'error', message })
    throw error
  }
}

export default flux1KreaReduxNode
