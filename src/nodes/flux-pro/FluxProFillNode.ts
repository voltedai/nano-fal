import { NanoSDK, NodeDefinition, NodeInstance } from '@nanograph/sdk'
import { QueueStatus } from '@fal-ai/client'
import { configureFalClient, fal } from '../../utils/fal-client.js'
import { createProgressStrategy } from '../../utils/progress-strategy.js'
import { getParameterValue } from '../../utils/parameter-utils.js'
import { FalImageReference, assetToDataUrl, uploadGeneratedImages } from './utils.js'

interface FluxProFillResponse {
  images?: FalImageReference[]
  seed?: number
  has_nsfw_concepts?: boolean[]
  data?: {
    images?: FalImageReference[]
    seed?: number
    has_nsfw_concepts?: boolean[]
  }
}

type FillVariantKey = 'flux-pro-v1-fill' | 'flux-pro-v1-fill-finetuned'

interface FillVariantConfig {
  endpoint: string
  label: string
  baseMs: number
  requiresFinetune?: boolean
}

const FILL_VARIANTS: Record<FillVariantKey, FillVariantConfig> = {
  'flux-pro-v1-fill': {
    endpoint: 'fal-ai/flux-pro/v1/fill',
    label: 'Flux Pro v1 Fill',
    baseMs: 30000
  },
  'flux-pro-v1-fill-finetuned': {
    endpoint: 'fal-ai/flux-pro/v1/fill-finetuned',
    label: 'Flux Pro v1 Fill (Fine-tuned)',
    baseMs: 32000,
    requiresFinetune: true
  }
}

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
  uid: 'fal-flux-pro-fill',
  name: 'Flux Pro Image Fill',
  category: 'Flux / Flux Pro',
  version: '1.0.0',
  type: 'server',
  description: 'Performs inpainting using Flux Pro Fill models with optional fine-tuned support',
  inputs: [
    {
      name: 'prompt',
      type: 'string',
      description: 'Text prompt describing what to fill into the masked area'
    },
    {
      name: 'image',
      type: 'asset:image',
      description: 'Base image to modify'
    },
    {
      name: 'mask',
      type: 'asset:image',
      description: 'Mask image indicating the region to inpaint (white/transparent = fill)'
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
      value: 'flux-pro-v1-fill',
      default: 'flux-pro-v1-fill',
      label: 'Model Variant',
      description: 'Choose between the standard and fine-tuned Flux Pro fill models',
      options: [
        { label: 'Flux Pro v1 Fill', value: 'flux-pro-v1-fill' },
        { label: 'Flux Pro v1 Fill (Fine-tuned)', value: 'flux-pro-v1-fill-finetuned' }
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
      description: 'Use a fixed seed (>=0) for repeatable fills'
    },
    {
      name: 'finetune_id',
      type: 'text',
      value: '',
      default: '',
      label: 'Fine-tune ID',
      description: 'Required for the fine-tuned Flux Pro Fill variant'
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
      description: 'Controls how strongly the fine-tune influences results (fine-tuned variant)'
    }
  ]
}

const fluxProFillNode: NodeInstance = NanoSDK.registerNode(nodeDefinition)

fluxProFillNode.execute = async ({ inputs, parameters, context }) => {
  configureFalClient()

  const prompt = inputs.prompt?.[0] as string
  const imageUri = inputs.image?.[0] as string
  const maskUri = inputs.mask?.[0] as string

  if (!prompt) {
    context.sendStatus({ type: 'error', message: 'Prompt is required' })
    throw new Error('Prompt is required')
  }

  if (!imageUri) {
    context.sendStatus({ type: 'error', message: 'An input image is required' })
    throw new Error('An input image is required')
  }

  if (!maskUri) {
    context.sendStatus({ type: 'error', message: 'A mask image is required' })
    throw new Error('A mask image is required')
  }

  const variantKey = ensureOption(
    getParameterValue(parameters, 'model_variant', 'flux-pro-v1-fill'),
    Object.keys(FILL_VARIANTS) as FillVariantKey[],
    'flux-pro-v1-fill'
  )

  const variant = FILL_VARIANTS[variantKey]

  context.sendStatus({ type: 'running', message: 'Preparing input assets...' })

  const [imageDataUrl, maskDataUrl] = await Promise.all([
    assetToDataUrl(imageUri),
    assetToDataUrl(maskUri)
  ])

  const numImages = clamp(Number(getParameterValue(parameters, 'num_images', 1)), 1, 4)
  const syncMode = Boolean(getParameterValue(parameters, 'sync_mode', false))
  const enhancePrompt = Boolean(getParameterValue(parameters, 'enhance_prompt', false))
  const safetyTolerance = ensureOption(getParameterValue(parameters, 'safety_tolerance', '2'), SAFETY_LEVELS, '2')
  const outputFormat = ensureOption(getParameterValue(parameters, 'output_format', 'jpeg'), OUTPUT_FORMATS, 'jpeg')

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
    image_url: imageDataUrl,
    mask_url: maskDataUrl,
    num_images: numImages,
    output_format: outputFormat,
    safety_tolerance: safetyTolerance,
    sync_mode: syncMode,
    enhance_prompt: enhancePrompt
  }

  if (typeof seed === 'number') {
    payload.seed = seed
  }

  if (variant.requiresFinetune) {
    payload.finetune_id = finetuneId.trim()
    payload.finetune_strength = finetuneStrength
  }

  const syncFactor = syncMode ? 1.2 : 1
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
    }) as FluxProFillResponse

    const responseData = (result as any)?.data ?? {}

    const directImages = Array.isArray(result.images) ? result.images : []
    const nestedImages = Array.isArray(responseData.images) ? responseData.images : []
    const images = (directImages.length ? directImages : nestedImages) as FalImageReference[]

    if (!images.length) {
      throw new Error('No images were returned by the Flux Pro Fill API')
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
    const message = error?.message || 'Failed to run Flux Pro Fill'
    context.sendStatus({ type: 'error', message })
    throw error
  }
}

export default fluxProFillNode
