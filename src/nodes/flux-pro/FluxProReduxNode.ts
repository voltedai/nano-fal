import { NanoSDK, NodeDefinition, NodeInstance } from '@nanograph/sdk'
import { QueueStatus } from '@fal-ai/client'
import { configureFalClient, fal } from '../../utils/fal-client.js'
import { createProgressStrategy } from '../../utils/progress-strategy.js'
import { getParameterValue } from '../../utils/parameter-utils.js'
import { FalImageReference, assetToDataUrl, uploadGeneratedImages } from './utils.js'

interface FluxProReduxResponse {
  images?: FalImageReference[]
  seed?: number
  has_nsfw_concepts?: boolean[]
  data?: {
    images?: FalImageReference[]
    seed?: number
    has_nsfw_concepts?: boolean[]
  }
}

type ReduxVariantKey = 'flux-pro-v1-redux' | 'flux-pro-v1_1-redux' | 'flux-pro-v1_1-ultra-redux'

interface ReduxVariantConfig {
  endpoint: string
  label: string
  baseMs: number
  supportsImageSize?: boolean
  supportsSamplingConfig?: boolean
  supportsAspectRatio?: boolean
  supportsSafetyChecker?: boolean
  supportsRawOutput?: boolean
  supportsImagePromptStrength?: boolean
}

const REDUX_VARIANTS: Record<ReduxVariantKey, ReduxVariantConfig> = {
  'flux-pro-v1-redux': {
    endpoint: 'fal-ai/flux-pro/v1/redux',
    label: 'Flux Pro v1 Redux',
    baseMs: 24000,
    supportsImageSize: true,
    supportsSamplingConfig: true
  },
  'flux-pro-v1_1-redux': {
    endpoint: 'fal-ai/flux-pro/v1.1/redux',
    label: 'Flux Pro v1.1 Redux',
    baseMs: 25000,
    supportsImageSize: true,
    supportsSamplingConfig: true
  },
  'flux-pro-v1_1-ultra-redux': {
    endpoint: 'fal-ai/flux-pro/v1.1-ultra/redux',
    label: 'Flux Pro v1.1 Ultra Redux',
    baseMs: 32000,
    supportsAspectRatio: true,
    supportsSafetyChecker: true,
    supportsRawOutput: true,
    supportsImagePromptStrength: true
  }
}

const IMAGE_SIZE_OPTIONS = ['landscape_4_3', 'landscape_16_9', 'portrait_4_3', 'portrait_16_9', 'square', 'square_hd'] as const
const ASPECT_RATIO_OPTIONS = ['21:9', '16:9', '4:3', '3:2', '1:1', '2:3', '3:4', '9:16', '9:21'] as const
const SAFETY_LEVELS = ['1', '2', '3', '4', '5', '6'] as const
const OUTPUT_FORMATS = ['jpeg', 'png'] as const

const clamp = (value: number, min: number, max: number): number => {
  if (Number.isNaN(value)) {
    return min
  }
  return Math.min(Math.max(value, min), max)
}

const ensureOption = <T extends string>(value: unknown, options: readonly T[], fallback: T): T => {
  if (typeof value === 'string' && (options as readonly string[]).includes(value)) {
    return value as T
  }
  return fallback
}

const nodeDefinition: NodeDefinition = {
  uid: 'fal-flux-pro-redux',
  name: 'Flux Pro Image Redux',
  category: 'Flux / Flux Pro',
  version: '1.0.0',
  type: 'server',
  description: 'Creates Flux Pro image variations using Flux Redux models, including Ultra support',
  inputs: [
    {
      name: 'image',
      type: 'asset:image',
      description: 'Source image to remix'
    },
    {
      name: 'prompt',
      type: 'string',
      description: 'Optional prompt describing the desired transformation'
    }
  ],
  outputs: [
    {
      name: 'images',
      type: 'asset:image',
      description: 'Generated images as NanoGraph asset URIs'
    },
    {
      name: 'seed',
      type: 'number',
      description: 'Seed returned by the Flux Pro API'
    },
    {
      name: 'has_nsfw_concepts',
      type: 'boolean',
      description: 'Flags per generated image indicating potential NSFW content'
    }
  ],
  parameters: [
    {
      name: 'model_variant',
      type: 'select',
      value: 'flux-pro-v1_1-redux',
      default: 'flux-pro-v1_1-redux',
      label: 'Model Variant',
      description: 'Choose which Flux Redux backend to call',
      options: [
        { label: 'Flux Pro v1 Redux', value: 'flux-pro-v1-redux' },
        { label: 'Flux Pro v1.1 Redux', value: 'flux-pro-v1_1-redux' },
        { label: 'Flux Pro v1.1 Ultra Redux', value: 'flux-pro-v1_1-ultra-redux' }
      ]
    },
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
      description: 'Used by Flux Pro v1 and v1.1 variants',
      options: IMAGE_SIZE_OPTIONS.map((option) => ({ label: option.replace('_', ' '), value: option }))
    },
    {
      name: 'aspect_ratio',
      type: 'select',
      value: '16:9',
      default: '16:9',
      label: 'Aspect Ratio',
      description: 'Used by Flux Pro v1.1 Ultra Redux instead of explicit dimensions',
      options: ASPECT_RATIO_OPTIONS.map((ratio) => ({ label: ratio, value: ratio }))
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
      description: 'Used by Flux Pro v1 and v1.1 variants'
    },
    {
      name: 'guidance_scale',
      type: 'number',
      value: 3.5,
      default: 3.5,
      min: 1.5,
      max: 20,
      step: 0.1,
      label: 'Guidance Scale (CFG)',
      description: 'Used by Flux Pro v1 and v1.1 variants to control prompt adherence'
    },
    {
      name: 'output_format',
      type: 'select',
      value: 'jpeg',
      default: 'jpeg',
      label: 'Output Format',
      description: 'Format of the generated images',
      options: [
        { label: 'JPEG', value: 'jpeg' },
        { label: 'PNG', value: 'png' }
      ]
    },
    {
      name: 'sync_mode',
      type: 'boolean',
      value: false,
      default: false,
      label: 'Sync Mode',
      description: 'Wait for Fal uploads before returning (more latency)'
    },
    {
      name: 'safety_tolerance',
      type: 'select',
      value: '2',
      default: '2',
      label: 'Safety Tolerance',
      description: 'Content safety strictness (1 = strict, 6 = most permissive)',
      options: SAFETY_LEVELS.map((level) => ({ label: level, value: level }))
    },
    {
      name: 'enable_safety_checker',
      type: 'boolean',
      value: true,
      default: true,
      label: 'Enable Safety Checker',
      description: 'Available on Flux Pro v1.1 Ultra Redux'
    },
    {
      name: 'raw',
      type: 'boolean',
      value: false,
      default: false,
      label: 'Raw Output',
      description: 'Flux Pro Ultra option for less processed imagery'
    },
    {
      name: 'image_prompt_strength',
      type: 'number',
      value: 0.1,
      default: 0.1,
      min: 0,
      max: 1,
      step: 0.05,
      label: 'Image Prompt Strength',
      description: 'Controls how strongly the input image guides Ultra Redux generations'
    },
    {
      name: 'enhance_prompt',
      type: 'boolean',
      value: false,
      default: false,
      label: 'Enhance Prompt',
      description: 'Let the model enhance the prompt automatically'
    },
    {
      name: 'seed',
      type: 'number',
      value: -1,
      default: -1,
      min: -1,
      step: 1,
      label: 'Seed (-1 = random)',
      description: 'Use a fixed seed (>=0) for repeatable variations'
    }
  ]
}

const fluxProReduxNode: NodeInstance = NanoSDK.registerNode(nodeDefinition)

fluxProReduxNode.execute = async ({ inputs, parameters, context }) => {
  configureFalClient()

  const imageUri = inputs.image?.[0] as string
  const prompt = inputs.prompt?.[0] as string | undefined

  if (!imageUri) {
    context.sendStatus({ type: 'error', message: 'An input image is required' })
    throw new Error('An input image is required')
  }

  const variantKey = ensureOption(
    getParameterValue(parameters, 'model_variant', 'flux-pro-v1_1-redux'),
    Object.keys(REDUX_VARIANTS) as ReduxVariantKey[],
    'flux-pro-v1_1-redux'
  )

  const variant = REDUX_VARIANTS[variantKey]

  context.sendStatus({ type: 'running', message: 'Preparing input image...' })

  const imageDataUrl = await assetToDataUrl(imageUri)

  const numImages = clamp(Number(getParameterValue(parameters, 'num_images', 1)), 1, 4)
  const syncMode = Boolean(getParameterValue(parameters, 'sync_mode', false))
  const enhancePrompt = Boolean(getParameterValue(parameters, 'enhance_prompt', false))
  const safetyTolerance = ensureOption(getParameterValue(parameters, 'safety_tolerance', '2'), SAFETY_LEVELS, '2')
  const outputFormat = ensureOption(getParameterValue(parameters, 'output_format', 'jpeg'), OUTPUT_FORMATS, 'jpeg')

  const imageSize = ensureOption(getParameterValue(parameters, 'image_size', 'landscape_4_3'), IMAGE_SIZE_OPTIONS, 'landscape_4_3')
  const aspectRatio = ensureOption(getParameterValue(parameters, 'aspect_ratio', '16:9'), ASPECT_RATIO_OPTIONS, '16:9')

  const numInferenceSteps = clamp(Number(getParameterValue(parameters, 'num_inference_steps', 28)), 1, 50)
  const guidanceScale = clamp(Number(getParameterValue(parameters, 'guidance_scale', 3.5)), 1.5, 20)

  const enableSafetyChecker = Boolean(getParameterValue(parameters, 'enable_safety_checker', true))
  const rawOutput = Boolean(getParameterValue(parameters, 'raw', false))
  const imagePromptStrength = clamp(Number(getParameterValue(parameters, 'image_prompt_strength', 0.1)), 0, 1)

  const seedValue = Number(getParameterValue(parameters, 'seed', -1))
  const seed = Number.isInteger(seedValue) && seedValue >= 0 ? seedValue : undefined

  const payload: Record<string, unknown> = {
    prompt: typeof prompt === 'string' ? prompt : '',
    image_url: imageDataUrl,
    num_images: numImages,
    output_format: outputFormat,
    safety_tolerance: safetyTolerance,
    sync_mode: syncMode,
    enhance_prompt: enhancePrompt
  }

  if (typeof seed === 'number') {
    payload.seed = seed
  }

  if (variant.supportsImageSize) {
    payload.image_size = imageSize
    payload.num_inference_steps = numInferenceSteps
    payload.guidance_scale = guidanceScale
  }

  if (variant.supportsAspectRatio) {
    payload.aspect_ratio = aspectRatio
  }

  if (variant.supportsSafetyChecker) {
    payload.enable_safety_checker = enableSafetyChecker
  }

  if (variant.supportsRawOutput) {
    payload.raw = rawOutput
  }

  if (variant.supportsImagePromptStrength) {
    payload.image_prompt_strength = imagePromptStrength
  }

  const syncFactor = syncMode ? 1.2 : 1
  const expectedMs = Math.min(120000, Math.max(16000, Math.floor(variant.baseMs * numImages * syncFactor)))

  const strategy = createProgressStrategy({
    expectedMs,
    inQueueMessage: `Waiting for ${variant.label}...`,
    finalizingMessage: 'Finalizing images...',
    defaultInProgressMessage: (step) => `Processing step ${step}...`
  })

  try {
    let stepCount = 0

    const result = await fal.subscribe(variant.endpoint, {
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
    }) as FluxProReduxResponse

    const responseData = (result as any)?.data ?? {}

    const directImages = Array.isArray(result.images) ? result.images : []
    const nestedImages = Array.isArray(responseData.images) ? responseData.images : []
    const images = (directImages.length ? directImages : nestedImages) as FalImageReference[]

    if (!images.length) {
      throw new Error('No images were returned by the Flux Pro Redux API')
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
    const message = error?.message || 'Failed to run Flux Pro Redux'
    context.sendStatus({ type: 'error', message })
    throw error
  }
}

export default fluxProReduxNode
