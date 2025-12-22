import { NanoSDK, NodeDefinition, NodeInstance } from '@nanograph/sdk'
import { QueueStatus } from '@fal-ai/client'
import { configureFalClient, fal } from '../../utils/fal-client.js'
import { createProgressStrategy } from '../../utils/progress-strategy.js'
import { getParameterValue } from '../../utils/parameter-utils.js'
import { FalImageReference, uploadGeneratedImages } from './utils.js'

interface FluxProTextToImageResponse {
  images?: FalImageReference[]
  seed?: number
  has_nsfw_concepts?: boolean[]
  data?: {
    images?: FalImageReference[]
    seed?: number
    has_nsfw_concepts?: boolean[]
  }
}

type TextToImageVariantKey = 'flux-pro-new' | 'flux-pro-v1_1' | 'flux-pro-v1_1-ultra' | 'flux-pro-v1_1-ultra-finetuned'

interface TextToImageVariantConfig {
  endpoint: string
  label: string
  baseMs: number
  supportsImageSize?: boolean
  supportsSamplingConfig?: boolean
  supportsAspectRatio?: boolean
  supportsSafetyChecker?: boolean
  supportsRawOutput?: boolean
  requiresFinetune?: boolean
}

const TEXT_TO_IMAGE_VARIANTS: Record<TextToImageVariantKey, TextToImageVariantConfig> = {
  'flux-pro-new': {
    endpoint: 'fal-ai/flux-pro/new',
    label: 'Flux Pro New',
    baseMs: 26000,
    supportsImageSize: true,
    supportsSamplingConfig: true
  },
  'flux-pro-v1_1': {
    endpoint: 'fal-ai/flux-pro/v1.1',
    label: 'Flux Pro v1.1',
    baseMs: 22000,
    supportsImageSize: true,
    supportsSafetyChecker: true
  },
  'flux-pro-v1_1-ultra': {
    endpoint: 'fal-ai/flux-pro/v1.1-ultra',
    label: 'Flux Pro v1.1 Ultra',
    baseMs: 32000,
    supportsAspectRatio: true,
    supportsSafetyChecker: true,
    supportsRawOutput: true
  },
  'flux-pro-v1_1-ultra-finetuned': {
    endpoint: 'fal-ai/flux-pro/v1.1-ultra-finetuned',
    label: 'Flux Pro v1.1 Ultra (Fine-tuned)',
    baseMs: 34000,
    supportsAspectRatio: true,
    supportsSafetyChecker: true,
    supportsRawOutput: true,
    requiresFinetune: true
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
  uid: 'fal-flux-pro-text-to-image',
  name: 'Flux Pro Text to Image',
  category: 'Flux / Flux Pro',
  version: '1.0.0',
  type: 'server',
  description: 'Generates images from text prompts using Fal Flux Pro models, including Ultra and fine-tuned variants',
  inputs: [
    {
      name: 'prompt',
      type: 'string',
      description: 'Text prompt describing the image to generate'
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
      description: 'Seed returned by the Flux Pro API (when deterministic generation is used)'
    },
    {
      name: 'has_nsfw_concepts',
      type: 'boolean',
      description: 'Flag per generated image indicating potential NSFW content'
    }
  ],
  parameters: [
    {
      name: 'model_variant',
      type: 'select',
      value: 'flux-pro-new',
      default: 'flux-pro-new',
      label: 'Model Variant',
      description: 'Choose which Flux Pro backend to call',
      options: [
        { label: 'Flux Pro New', value: 'flux-pro-new' },
        { label: 'Flux Pro v1.1', value: 'flux-pro-v1_1' },
        { label: 'Flux Pro v1.1 Ultra', value: 'flux-pro-v1_1-ultra' },
        { label: 'Flux Pro v1.1 Ultra (Fine-tuned)', value: 'flux-pro-v1_1-ultra-finetuned' }
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
      description: 'How many images to generate (1-4)'
    },
    {
      name: 'image_size',
      type: 'select',
      value: 'landscape_4_3',
      default: 'landscape_4_3',
      label: 'Image Size Preset',
      description: 'Used by Flux Pro New and v1.1 variants',
      options: IMAGE_SIZE_OPTIONS.map((option) => ({ label: option.replace('_', ' '), value: option }))
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
      description: 'Used by Flux Pro New to control denoising steps'
    },
    {
      name: 'guidance_scale',
      type: 'number',
      value: 3.5,
      default: 3.5,
      min: 1,
      max: 20,
      step: 0.1,
      label: 'Guidance Scale (CFG)',
      description: 'Used by Flux Pro New to control how strictly the model follows the prompt'
    },
    {
      name: 'aspect_ratio',
      type: 'select',
      value: '16:9',
      default: '16:9',
      label: 'Aspect Ratio',
      description: 'Used by Flux Pro Ultra variants instead of explicit image size',
      options: ASPECT_RATIO_OPTIONS.map((ratio) => ({ label: ratio, value: ratio }))
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
      description: 'Wait for Fal to upload images before returning (increases latency)'
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
      description: 'Available on Flux Pro v1.1 and Ultra variants'
    },
    {
      name: 'enhance_prompt',
      type: 'boolean',
      value: false,
      default: false,
      label: 'Enhance Prompt',
      description: 'Let the model automatically enhance the prompt for additional detail'
    },
    {
      name: 'raw',
      type: 'boolean',
      value: false,
      default: false,
      label: 'Raw Output',
      description: 'Flux Pro Ultra option for less processed, more natural-looking images'
    },
    {
      name: 'seed',
      type: 'number',
      value: -1,
      default: -1,
      min: -1,
      step: 1,
      label: 'Seed (-1 = random)',
      description: 'Use a fixed seed (>= 0) for repeatable generations'
    },
    {
      name: 'finetune_id',
      type: 'text',
      value: '',
      default: '',
      label: 'Fine-tune ID',
      description: 'Required for the Flux Pro Ultra fine-tuned variant'
    },
    {
      name: 'finetune_strength',
      type: 'number',
      value: 1,
      default: 1,
      min: 0,
      max: 2,
      step: 0.05,
      label: 'Fine-tune Strength',
      description: 'Controls how strongly the fine-tune influences the output (Ultra fine-tuned variant)'
    }
  ]
}

const fluxProTextToImageNode: NodeInstance = NanoSDK.registerNode(nodeDefinition)

fluxProTextToImageNode.execute = async ({ inputs, parameters, context }) => {
  configureFalClient()

  const prompt = inputs.prompt?.[0] as string

  if (!prompt) {
    context.sendStatus({ type: 'error', message: 'Prompt is required' })
    throw new Error('Prompt is required')
  }

  const variantKey = ensureOption(
    getParameterValue(parameters, 'model_variant', 'flux-pro-new'),
    Object.keys(TEXT_TO_IMAGE_VARIANTS) as TextToImageVariantKey[],
    'flux-pro-new'
  )

  const variant = TEXT_TO_IMAGE_VARIANTS[variantKey]

  const numImages = clamp(Number(getParameterValue(parameters, 'num_images', 1)), 1, 4)
  const syncMode = Boolean(getParameterValue(parameters, 'sync_mode', false))
  const enhancePrompt = Boolean(getParameterValue(parameters, 'enhance_prompt', false))
  const safetyTolerance = ensureOption(getParameterValue(parameters, 'safety_tolerance', '2'), SAFETY_LEVELS, '2')
  const outputFormat = ensureOption(getParameterValue(parameters, 'output_format', 'jpeg'), OUTPUT_FORMATS, 'jpeg')

  const seedValue = Number(getParameterValue(parameters, 'seed', -1))
  const seed = Number.isInteger(seedValue) && seedValue >= 0 ? seedValue : undefined

  const enableSafetyChecker = Boolean(getParameterValue(parameters, 'enable_safety_checker', true))
  const rawOutput = Boolean(getParameterValue(parameters, 'raw', false))
  const imageSize = ensureOption(getParameterValue(parameters, 'image_size', 'landscape_4_3'), IMAGE_SIZE_OPTIONS, 'landscape_4_3')
  const aspectRatio = ensureOption(getParameterValue(parameters, 'aspect_ratio', '16:9'), ASPECT_RATIO_OPTIONS, '16:9')

  const numInferenceSteps = clamp(
    Number(getParameterValue(parameters, 'num_inference_steps', 28)),
    1,
    50
  )
  const guidanceScale = clamp(
    Number(getParameterValue(parameters, 'guidance_scale', 3.5)),
    1,
    20
  )

  const finetuneId = String(getParameterValue(parameters, 'finetune_id', '') || '')
  const finetuneStrength = clamp(Number(getParameterValue(parameters, 'finetune_strength', 1)), 0, 2)

  if (variant.requiresFinetune) {
    if (!finetuneId.trim()) {
      context.sendStatus({ type: 'error', message: 'Fine-tune ID is required for the selected model variant' })
      throw new Error('Fine-tune ID is required for the selected model variant')
    }
    if (Number.isNaN(finetuneStrength)) {
      context.sendStatus({ type: 'error', message: 'Fine-tune strength is required for the selected model variant' })
      throw new Error('Fine-tune strength is required for the selected model variant')
    }
  }

  const payload: Record<string, unknown> = {
    prompt,
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
  }

  if (variant.supportsSamplingConfig) {
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

  if (variant.requiresFinetune) {
    payload.finetune_id = finetuneId.trim()
    payload.finetune_strength = finetuneStrength
  }

  const syncFactor = syncMode ? 1.25 : 1
  const expectedMs = Math.min(120000, Math.max(15000, Math.floor(variant.baseMs * numImages * syncFactor)))

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
    }) as FluxProTextToImageResponse

    const responseData = (result as any)?.data ?? {}

    const directImages = Array.isArray(result.images) ? result.images : []
    const nestedImages = Array.isArray(responseData.images) ? responseData.images : []
    const images = (directImages.length ? directImages : nestedImages) as FalImageReference[]

    if (!images.length) {
      throw new Error('No images were returned by the Flux Pro API')
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
    const message = error?.message || 'Failed to generate images with Flux Pro'
    context.sendStatus({ type: 'error', message })
    throw error
  }
}

export default fluxProTextToImageNode
