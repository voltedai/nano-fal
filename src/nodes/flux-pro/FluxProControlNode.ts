import { NanoSDK, NodeDefinition, NodeInstance } from '@nanograph/sdk'
import { QueueStatus } from '@fal-ai/client'
import { configureFalClient, fal } from '../../utils/fal-client.js'
import { createProgressStrategy } from '../../utils/progress-strategy.js'
import { getParameterValue } from '../../utils/parameter-utils.js'
import { FalImageReference, assetToDataUrl, uploadGeneratedImages } from './utils.js'

interface FluxProControlResponse {
  images?: FalImageReference[]
  seed?: number
  has_nsfw_concepts?: boolean[]
  data?: {
    images?: FalImageReference[]
    seed?: number
    has_nsfw_concepts?: boolean[]
  }
}

type ControlVariantKey =
  | 'flux-pro-v1-canny'
  | 'flux-pro-v1-canny-finetuned'
  | 'flux-pro-v1-depth'
  | 'flux-pro-v1-depth-finetuned'

interface ControlVariantConfig {
  endpoint: string
  label: string
  baseMs: number
  requiresFinetune?: boolean
  guidanceMin: number
  guidanceMax: number
}

const CONTROL_VARIANTS: Record<ControlVariantKey, ControlVariantConfig> = {
  'flux-pro-v1-canny': {
    endpoint: 'fal-ai/flux-pro/v1/canny',
    label: 'Flux Pro v1 Canny',
    baseMs: 28000,
    guidanceMin: 1,
    guidanceMax: 20
  },
  'flux-pro-v1-canny-finetuned': {
    endpoint: 'fal-ai/flux-pro/v1/canny-finetuned',
    label: 'Flux Pro v1 Canny (Fine-tuned)',
    baseMs: 30000,
    requiresFinetune: true,
    guidanceMin: 1,
    guidanceMax: 40
  },
  'flux-pro-v1-depth': {
    endpoint: 'fal-ai/flux-pro/v1/depth',
    label: 'Flux Pro v1 Depth',
    baseMs: 28000,
    guidanceMin: 1,
    guidanceMax: 20
  },
  'flux-pro-v1-depth-finetuned': {
    endpoint: 'fal-ai/flux-pro/v1/depth-finetuned',
    label: 'Flux Pro v1 Depth (Fine-tuned)',
    baseMs: 30000,
    requiresFinetune: true,
    guidanceMin: 1,
    guidanceMax: 40
  }
}

const IMAGE_SIZE_OPTIONS = ['landscape_4_3', 'landscape_16_9', 'portrait_4_3', 'portrait_16_9', 'square', 'square_hd'] as const
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
  uid: 'fal-flux-pro-control-image',
  name: 'Flux Pro Control Image Generation',
  category: 'Flux / Flux Pro',
  version: '1.0.0',
  type: 'server',
  description: 'Generates images using Flux Pro ControlNet (Canny/Depth) models, with optional fine-tuned variants',
  inputs: [
    {
      name: 'prompt',
      type: 'string',
      description: 'Text prompt describing the image to generate'
    },
    {
      name: 'control_image',
      type: 'asset:image',
      description: 'Control image used to extract edges or depth information'
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
      value: 'flux-pro-v1-canny',
      default: 'flux-pro-v1-canny',
      label: 'Model Variant',
      description: 'Choose which control model to use',
      options: [
        { label: 'Flux Pro v1 Canny', value: 'flux-pro-v1-canny' },
        { label: 'Flux Pro v1 Canny (Fine-tuned)', value: 'flux-pro-v1-canny-finetuned' },
        { label: 'Flux Pro v1 Depth', value: 'flux-pro-v1-depth' },
        { label: 'Flux Pro v1 Depth (Fine-tuned)', value: 'flux-pro-v1-depth-finetuned' }
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
      description: 'Preset sizes supported by Flux Pro Control models',
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
      description: 'Number of denoising steps (1-50)'
    },
    {
      name: 'guidance_scale',
      type: 'number',
      value: 3.5,
      default: 3.5,
      min: 1,
      max: 40,
      step: 0.5,
      label: 'Guidance Scale (CFG)',
      description: 'Controls how strongly the image should follow the prompt'
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
      description: 'Use a fixed seed (>=0) for repeatable generations'
    },
    {
      name: 'finetune_id',
      type: 'text',
      value: '',
      default: '',
      label: 'Fine-tune ID',
      description: 'Required for the fine-tuned control variants'
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
      description: 'Controls how strongly the fine-tune influences the output (fine-tuned variants)'
    }
  ]
}

const fluxProControlNode: NodeInstance = NanoSDK.registerNode(nodeDefinition)

fluxProControlNode.execute = async ({ inputs, parameters, context }) => {
  configureFalClient()

  const prompt = inputs.prompt?.[0] as string
  const controlImageUri = inputs.control_image?.[0] as string

  if (!prompt) {
    context.sendStatus({ type: 'error', message: 'Prompt is required' })
    throw new Error('Prompt is required')
  }

  if (!controlImageUri) {
    context.sendStatus({ type: 'error', message: 'A control image is required' })
    throw new Error('A control image is required')
  }

  const variantKey = ensureOption(
    getParameterValue(parameters, 'model_variant', 'flux-pro-v1-canny'),
    Object.keys(CONTROL_VARIANTS) as ControlVariantKey[],
    'flux-pro-v1-canny'
  )

  const variant = CONTROL_VARIANTS[variantKey]

  context.sendStatus({ type: 'running', message: 'Preparing control image...' })

  const controlImageDataUrl = await assetToDataUrl(controlImageUri)

  const numImages = clamp(Number(getParameterValue(parameters, 'num_images', 1)), 1, 4)
  const imageSize = ensureOption(getParameterValue(parameters, 'image_size', 'landscape_4_3'), IMAGE_SIZE_OPTIONS, 'landscape_4_3')
  const numInferenceSteps = clamp(Number(getParameterValue(parameters, 'num_inference_steps', 28)), 1, 50)

  const rawGuidance = Number(getParameterValue(parameters, 'guidance_scale', 3.5))
  const guidanceScale = clamp(rawGuidance, variant.guidanceMin, variant.guidanceMax)

  const outputFormat = ensureOption(getParameterValue(parameters, 'output_format', 'jpeg'), OUTPUT_FORMATS, 'jpeg')
  const syncMode = Boolean(getParameterValue(parameters, 'sync_mode', false))
  const safetyTolerance = ensureOption(getParameterValue(parameters, 'safety_tolerance', '2'), SAFETY_LEVELS, '2')
  const enhancePrompt = Boolean(getParameterValue(parameters, 'enhance_prompt', false))

  const seedValue = Number(getParameterValue(parameters, 'seed', -1))
  const seed = Number.isInteger(seedValue) && seedValue >= 0 ? seedValue : undefined

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
    control_image_url: controlImageDataUrl,
    image_size: imageSize,
    num_inference_steps: numInferenceSteps,
    guidance_scale: guidanceScale,
    num_images: numImages,
    output_format: outputFormat,
    sync_mode: syncMode,
    safety_tolerance: safetyTolerance,
    enhance_prompt: enhancePrompt
  }

  if (typeof seed === 'number') {
    payload.seed = seed
  }

  if (variant.requiresFinetune) {
    payload.finetune_id = finetuneId.trim()
    payload.finetune_strength = finetuneStrength
  }

  const syncFactor = syncMode ? 1.25 : 1
  const expectedMs = Math.min(120000, Math.max(18000, Math.floor(variant.baseMs * numImages * syncFactor)))

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
    }) as FluxProControlResponse

    const responseData = (result as any)?.data ?? {}

    const directImages = Array.isArray(result.images) ? result.images : []
    const nestedImages = Array.isArray(responseData.images) ? responseData.images : []
    const images = (directImages.length ? directImages : nestedImages) as FalImageReference[]

    if (!images.length) {
      throw new Error('No images were returned by the Flux Pro Control API')
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
    const message = error?.message || 'Failed to run Flux Pro Control generation'
    context.sendStatus({ type: 'error', message })
    throw error
  }
}

export default fluxProControlNode
