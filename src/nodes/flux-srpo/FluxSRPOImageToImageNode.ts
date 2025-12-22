import { NanoSDK, NodeDefinition, NodeInstance, resolveAsset, uploadAsset } from '@nanograph/sdk'
import { QueueStatus } from '@fal-ai/client'
import { configureFalClient, fal } from '../../utils/fal-client.js'
import { getParameterValue } from '../../utils/parameter-utils.js'
import { createProgressStrategy } from '../../utils/progress-strategy.js'
import { uploadBufferToFal } from '../../utils/fal-storage.js'
import { generateAssetFilename } from '../../utils/asset-utils.js'

interface FluxSrpoImage {
  url?: string
}

interface FluxSrpoImageToImageResponse {
  images?: FluxSrpoImage[]
  seed?: number
  has_nsfw_concepts?: boolean[]
}

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max)

const allowedFormats = new Set(['jpeg', 'png'])
const allowedAccelerations = new Set(['none', 'regular', 'high'])

const detectImageFormat = (buffer: Buffer): string => {
  if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'jpeg'
  }
  if (
    buffer.length > 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return 'png'
  }
  if (
    buffer.length > 12 &&
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return 'webp'
  }
  return 'jpeg'
}

const nodeDefinition: NodeDefinition = {
  uid: 'fal-flux-srpo-image-to-image',
  name: 'Flux SRPO Image to Image',
  category: 'Flux / Flux SRPO',
  version: '1.0.0',
  type: 'server',
  description: 'Transforms an input image using a text prompt with the Fal.ai Flux SRPO image-to-image model',
  inputs: [
    {
      name: 'prompt',
      type: 'string',
      description: 'Text prompt describing the desired transformation'
    },
    {
      name: 'image',
      type: 'asset:image',
      description: 'Source image to transform'
    }
  ],
  outputs: [
    {
      name: 'images',
      type: 'asset:image',
      description: 'Transformed images as asset URIs'
    },
    {
      name: 'seed',
      type: 'number',
      description: 'Seed returned by the Fal API'
    },
    {
      name: 'has_nsfw_concepts',
      type: 'boolean',
      description: 'NSFW flags reported per transformed image'
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
      name: 'strength',
      type: 'number',
      value: 0.95,
      default: 0.95,
      label: 'Strength',
      description: 'How strongly to follow the source image (0.01 - 1)',
      min: 0.01,
      max: 1
    },
    {
      name: 'num_inference_steps',
      type: 'number',
      value: 40,
      default: 40,
      label: 'Inference Steps',
      description: 'Number of denoising steps (10-50)',
      min: 10,
      max: 50
    },
    {
      name: 'guidance_scale',
      type: 'number',
      value: 4.5,
      default: 4.5,
      label: 'Guidance Scale (CFG)',
      description: 'How strongly the result should follow the prompt (1-20)',
      min: 1,
      max: 20
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
      description: 'Format of the returned images',
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

const fluxSrpoImageToImageNode: NodeInstance = NanoSDK.registerNode(nodeDefinition)

fluxSrpoImageToImageNode.execute = async ({ inputs, parameters, context }) => {
  configureFalClient()

  const prompt = inputs.prompt?.[0] as string
  const imageUri = inputs.image?.[0] as string

  if (!prompt) {
    context.sendStatus({ type: 'error', message: 'Prompt is required' })
    throw new Error('Prompt is required')
  }

  if (!imageUri) {
    context.sendStatus({ type: 'error', message: 'An input image is required' })
    throw new Error('An input image is required')
  }

  const modelVariant = String(getParameterValue(parameters, 'model_variant', 'flux-1'))
  const endpoint = modelVariant === 'classic'
    ? 'fal-ai/flux/srpo/image-to-image'
    : 'fal-ai/flux-1/srpo/image-to-image'
  const variantLabel = modelVariant === 'classic' ? 'Flux SRPO' : 'Flux-1 SRPO'

  const strength = clamp(Number(getParameterValue(parameters, 'strength', 0.95)), 0.01, 1)
  const numInferenceSteps = clamp(Math.round(Number(getParameterValue(parameters, 'num_inference_steps', 40))), 10, 50)
  const rawGuidanceScale = Number(getParameterValue(parameters, 'guidance_scale', 4.5))
  const guidanceScale = Math.min(Math.max(rawGuidanceScale, 1), 20)
  const numImages = clamp(Math.round(Number(getParameterValue(parameters, 'num_images', 1))), 1, 4)
  const seedValue = Number(getParameterValue(parameters, 'seed', -1))
  const requestedFormat = String(getParameterValue(parameters, 'output_format', 'jpeg'))
  const outputFormat = allowedFormats.has(requestedFormat) ? requestedFormat : 'jpeg'
  const requestedAcceleration = String(getParameterValue(parameters, 'acceleration', modelVariant === 'classic' ? 'none' : 'regular'))
  const acceleration = allowedAccelerations.has(requestedAcceleration)
    ? requestedAcceleration
    : (modelVariant === 'classic' ? 'none' : 'regular')
  const enableSafetyChecker = Boolean(getParameterValue(parameters, 'enable_safety_checker', true))
  const syncMode = Boolean(getParameterValue(parameters, 'sync_mode', false))

  context.sendStatus({ type: 'running', message: `Preparing source image for ${variantLabel}...` })

  const buffer = await resolveAsset(imageUri, { asBuffer: true }) as Buffer
  const detectedFormat = detectImageFormat(buffer)
  const imageUrl = await uploadBufferToFal(buffer, detectedFormat, { filenamePrefix: 'flux-srpo-source' })

  const payload: any = {
    prompt,
    image_url: imageUrl,
    strength,
    num_inference_steps: numInferenceSteps,
    guidance_scale: guidanceScale,
    num_images: numImages,
    output_format: outputFormat,
    acceleration,
    enable_safety_checker: enableSafetyChecker,
    sync_mode: syncMode
  }

  if (Number.isInteger(seedValue) && seedValue >= 0) {
    payload.seed = seedValue
  }

  const accelerationFactor = acceleration === 'high' ? 0.65 : acceleration === 'regular' ? 0.85 : 1
  const syncFactor = syncMode ? 1.15 : 1
  const expectedMs = Math.min(
    180000,
    Math.max(20000, Math.floor(numImages * numInferenceSteps * 620 * accelerationFactor * syncFactor))
  )
  const strategy = createProgressStrategy({
    expectedMs,
    inQueueMessage: 'Waiting in queue...',
    finalizingMessage: 'Finalizing images...',
    defaultInProgressMessage: (n) => `Processing step ${n}...`
  })

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
    }) as FluxSrpoImageToImageResponse

    console.log(`[Flux SRPO Image2Image] Fal response (${variantLabel}):`, JSON.stringify(result, null, 2))

    const responseData = (result as any)?.data ?? {}
    const directImages = Array.isArray(result.images) ? result.images : []
    const dataImages = Array.isArray(responseData.images) ? responseData.images : []
    const images = directImages.length ? directImages : dataImages

    if (!images.length) {
      throw new Error(`No images were returned by the ${variantLabel} image-to-image API`)
    }

    const uploadedUris: string[] = []

    for (const image of images) {
      if (!image.url) {
        continue
      }

      const response = await fetch(image.url)
      const contentType = response.headers.get('content-type')
      const arrayBuffer = await response.arrayBuffer()
      const resultBuffer = Buffer.from(arrayBuffer)
      const filename = generateAssetFilename(image.url, contentType, 'image')
      const uploadResult = await uploadAsset(resultBuffer, { type: 'image', filename })

      if (!uploadResult.uri) {
        throw new Error('Failed to upload transformed image')
      }

      uploadedUris.push(uploadResult.uri)
    }

    if (!uploadedUris.length) {
      throw new Error('Transformed images could not be retrieved')
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

    return {
      images: uploadedUris,
      seed: seedValueFromResponse !== undefined ? [seedValueFromResponse] : [],
      has_nsfw_concepts: hasNsfw
    }
  } catch (error: any) {
    const message = error?.message ?? `Failed to transform image with ${variantLabel}`
    context.sendStatus({ type: 'error', message })
    throw error
  }
}

export default fluxSrpoImageToImageNode
