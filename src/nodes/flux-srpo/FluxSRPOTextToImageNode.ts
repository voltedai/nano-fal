import { NanoSDK, NodeDefinition, NodeInstance, uploadAsset } from '@nanograph/sdk'
import { QueueStatus } from '@fal-ai/client'
import { configureFalClient, fal } from '../../utils/fal-client.js'
import { getParameterValue } from '../../utils/parameter-utils.js'
import { createProgressStrategy } from '../../utils/progress-strategy.js'
import { generateAssetFilename } from '../../utils/asset-utils.js'

interface FluxSrpoImage {
  url?: string
}

interface FluxSrpoTextToImageResponse {
  images?: FluxSrpoImage[]
  seed?: number
  has_nsfw_concepts?: boolean[]
}

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max)

const allowedFormats = new Set(['jpeg', 'png'])
const allowedAccelerations = new Set(['none', 'regular', 'high'])

const nodeDefinition: NodeDefinition = {
  uid: 'fal-flux-srpo-text-to-image',
  name: 'Flux SRPO Text to Image',
  category: 'Flux / Flux SRPO',
  version: '1.0.0',
  type: 'server',
  description: 'Generates images from text prompts using the Fal.ai Flux SRPO model',
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
      description: 'Generated images as asset URIs'
    },
    {
      name: 'seed',
      type: 'number',
      description: 'Seed returned by the Fal API'
    },
    {
      name: 'has_nsfw_concepts',
      type: 'boolean',
      description: 'NSFW flags reported per generated image'
    }
  ],

  parameters: [
    {
      name: 'model_variant',
      type: 'select',
      value: 'flux-1',
      default: 'flux-1',
      label: 'Model Variant',
      description: 'Choose between Flux SRPO backends',
      options: [
        { label: 'Flux SRPO (Classic)', value: 'classic' },
        { label: 'Flux-1 SRPO (Latest)', value: 'flux-1' }
      ]
    },
    {
      name: 'num_images',
      type: 'number',
      value: 1,
      default: 1,
      label: 'Number of Images',
      description: 'How many images to generate (1-4)',
      min: 1,
      max: 4
    },
    {
      name: 'image_size',
      type: 'select',
      value: 'landscape_4_3',
      default: 'landscape_4_3',
      label: 'Image Size Preset',
      description: 'Choose a preset size or select Custom to specify dimensions',
      options: [
        { label: 'Landscape 4:3 (default)', value: 'landscape_4_3' },
        { label: 'Landscape 16:9', value: 'landscape_16_9' },
        { label: 'Portrait 4:3', value: 'portrait_4_3' },
        { label: 'Portrait 16:9', value: 'portrait_16_9' },
        { label: 'Square', value: 'square' },
        { label: 'Square HD', value: 'square_hd' },
        { label: 'Custom (use width & height)', value: 'custom' }
      ]
    },
    {
      name: 'custom_width',
      type: 'number',
      value: 1024,
      default: 1024,
      label: 'Custom Width',
      description: 'Width in pixels when Image Size Preset is Custom (64 - 14142)',
      min: 64,
      max: 14142
    },
    {
      name: 'custom_height',
      type: 'number',
      value: 768,
      default: 768,
      label: 'Custom Height',
      description: 'Height in pixels when Image Size Preset is Custom (64 - 14142)',
      min: 64,
      max: 14142
    },
    {
      name: 'num_inference_steps',
      type: 'number',
      value: 28,
      default: 28,
      label: 'Inference Steps',
      description: 'Number of denoising steps (1-50)',
      min: 1,
      max: 50
    },
    {
      name: 'guidance_scale',
      type: 'number',
      value: 4.5,
      default: 4.5,
      label: 'Guidance Scale (CFG)',
      description: 'How strongly the image should follow the prompt (1-20)',
      min: 1,
      max: 20
    },
    {
      name: 'seed',
      type: 'number',
      value: -1,
      default: -1,
      label: 'Seed (-1 = random)',
      description: 'Set a fixed seed for reproducibility; use -1 for random'
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
      name: 'acceleration',
      type: 'select',
      value: 'none',
      default: 'none',
      label: 'Acceleration',
      description: 'Generation speed profile (higher = faster). Flux-1 default is Regular.',
      options: [
        { label: 'None', value: 'none' },
        { label: 'Regular', value: 'regular' },
        { label: 'High', value: 'high' }
      ]
    },
    {
      name: 'enable_safety_checker',
      type: 'boolean',
      value: true,
      default: true,
      label: 'Enable Safety Checker',
      description: 'Toggle the built-in Fal safety checker'
    },
    {
      name: 'sync_mode',
      type: 'boolean',
      value: false,
      default: false,
      label: 'Sync Mode',
      description: 'Wait for inline images before responding (increases latency)'
    }
  ]
}

const fluxSrpoTextToImageNode: NodeInstance = NanoSDK.registerNode(nodeDefinition)

fluxSrpoTextToImageNode.execute = async ({ inputs, parameters, context }) => {
  configureFalClient()

  const prompt = inputs.prompt?.[0] as string

  if (!prompt) {
    context.sendStatus({ type: 'error', message: 'Prompt is required' })
    throw new Error('Prompt is required')
  }

  const modelVariant = String(getParameterValue(parameters, 'model_variant', 'flux-1'))
  const endpoint = modelVariant === 'classic' ? 'fal-ai/flux/srpo' : 'fal-ai/flux-1/srpo'
  const variantLabel = modelVariant === 'classic' ? 'Flux SRPO' : 'Flux-1 SRPO'

  const numImages = clamp(Math.round(Number(getParameterValue(parameters, 'num_images', 1))), 1, 4)
  const imageSizePreset = String(getParameterValue(parameters, 'image_size', 'landscape_4_3'))
  const customWidth = clamp(Math.round(Number(getParameterValue(parameters, 'custom_width', 1024))), 64, 14142)
  const customHeight = clamp(Math.round(Number(getParameterValue(parameters, 'custom_height', 768))), 64, 14142)
  const numInferenceSteps = clamp(Math.round(Number(getParameterValue(parameters, 'num_inference_steps', 28))), 1, 50)
  const rawGuidanceScale = Number(getParameterValue(parameters, 'guidance_scale', 4.5))
  const guidanceScale = Math.min(Math.max(rawGuidanceScale, 1), 20)
  const seedValue = Number(getParameterValue(parameters, 'seed', -1))
  const requestedFormat = String(getParameterValue(parameters, 'output_format', 'jpeg'))
  const outputFormat = allowedFormats.has(requestedFormat) ? requestedFormat : 'jpeg'
  const requestedAcceleration = String(getParameterValue(parameters, 'acceleration', modelVariant === 'classic' ? 'none' : 'regular'))
  const acceleration = allowedAccelerations.has(requestedAcceleration) ? requestedAcceleration : (modelVariant === 'classic' ? 'none' : 'regular')
  const enableSafetyChecker = Boolean(getParameterValue(parameters, 'enable_safety_checker', true))
  const syncMode = Boolean(getParameterValue(parameters, 'sync_mode', false))

  const payload: any = {
    prompt,
    num_images: numImages,
    num_inference_steps: numInferenceSteps,
    guidance_scale: guidanceScale,
    output_format: outputFormat,
    acceleration,
    enable_safety_checker: enableSafetyChecker,
    sync_mode: syncMode
  }

  if (imageSizePreset === 'custom') {
    payload.image_size = {
      width: customWidth,
      height: customHeight
    }
  } else {
    payload.image_size = imageSizePreset
  }

  if (Number.isInteger(seedValue) && seedValue >= 0) {
    payload.seed = seedValue
  }

  const accelerationFactor = acceleration === 'high' ? 0.65 : acceleration === 'regular' ? 0.85 : 1
  const syncFactor = syncMode ? 1.15 : 1
  const expectedMs = Math.min(
    180000,
    Math.max(18000, Math.floor(numImages * numInferenceSteps * 650 * accelerationFactor * syncFactor))
  )
  const strategy = createProgressStrategy({
    expectedMs,
    inQueueMessage: 'Waiting in queue...',
    finalizingMessage: 'Finalizing images...',
    defaultInProgressMessage: (n) => `Processing step ${n}...`
  })

  context.sendStatus({ type: 'running', message: `Submitting ${variantLabel} request to Fal...` })

  try {
    let stepCount = 0

    const result = await fal.subscribe(endpoint, {
      input: payload,
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
    }) as FluxSrpoTextToImageResponse

    const responseData = (result as any)?.data ?? {}
    const directImages = Array.isArray(result.images) ? result.images : []
    const dataImages = Array.isArray(responseData.images) ? responseData.images : []
    const images = directImages.length ? directImages : dataImages

    if (!images.length) {
      throw new Error(`No images were returned by the ${variantLabel} API`)
    }

    const uploadedUris: string[] = []

    for (const image of images) {
      if (!image.url) {
        continue
      }

      const response = await fetch(image.url)
      const contentType = response.headers.get('content-type')
      const arrayBuffer = await response.arrayBuffer()
      const buffer = Buffer.from(arrayBuffer)
      const filename = generateAssetFilename(image.url, contentType, 'image')
      const uploadResult = await uploadAsset(buffer, { type: 'image', filename })

      if (!uploadResult.uri) {
        throw new Error('Failed to upload generated image')
      }

      uploadedUris.push(uploadResult.uri)
    }

    if (!uploadedUris.length) {
      throw new Error('Generated images could not be retrieved')
    }

    const hasNsfw = Array.isArray(result.has_nsfw_concepts)
      ? result.has_nsfw_concepts.map((flag) => Boolean(flag))
      : Array.isArray(responseData.has_nsfw_concepts)
        ? responseData.has_nsfw_concepts.map((flag: any) => Boolean(flag))
        : []

    const seedValueFromResponse = typeof result.seed === 'number'
      ? result.seed
      : typeof responseData.seed === 'number'
        ? responseData.seed
        : undefined

    const outputs: Record<string, any> = {
      images: uploadedUris,
      seed: seedValueFromResponse !== undefined ? [seedValueFromResponse] : [],
      has_nsfw_concepts: hasNsfw
    }

    return outputs
  } catch (error: any) {
    const message = error?.message ?? `Failed to generate images with ${variantLabel}`
    context.sendStatus({ type: 'error', message })
    throw error
  }
}

export default fluxSrpoTextToImageNode
