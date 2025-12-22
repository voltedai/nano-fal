import { NanoSDK, NodeDefinition, NodeInstance } from '@nanograph/sdk'
import { QueueStatus } from '@fal-ai/client'
import { configureFalClient, fal } from '../../utils/fal-client.js'
import { createProgressStrategy } from '../../utils/progress-strategy.js'
import { getParameterValue } from '../../utils/parameter-utils.js'
import { FalImageReference, assetToDataUrl, uploadGeneratedImages } from '../flux-pro/utils.js'

interface Flux1KreaImageToImageResponse {
  images?: FalImageReference[]
  seed?: number
  has_nsfw_concepts?: boolean[]
  data?: {
    images?: FalImageReference[]
    seed?: number
    has_nsfw_concepts?: boolean[]
  }
}

const allowedFormats = new Set(['jpeg', 'png'])
const allowedAccelerations = new Set(['none', 'regular', 'high'])

const clampNumber = (value: number, min: number, max: number): number => {
  if (Number.isNaN(value)) {
    return min
  }
  return Math.min(Math.max(value, min), max)
}

const nodeDefinition: NodeDefinition = {
  uid: 'fal-flux1-krea-image-to-image',
  name: 'Flux-1 Krea Image to Image',
  category: 'Flux / Krea 1.1',
  version: '1.0.0',
  type: 'server',
  description: 'Creates Flux-1 Krea variations from an input image and prompt',
  inputs: [
    {
      name: 'prompt',
      type: 'string',
      description: 'Text prompt describing the desired transformation'
    },
    {
      name: 'image',
      type: 'asset:image',
      description: 'Source image asset to transform'
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
      name: 'strength',
      type: 'number',
      value: 0.95,
      default: 0.95,
      min: 0.01,
      max: 1,
      step: 0.01,
      label: 'Image Strength',
      description: 'Higher values keep more of the original image (0.01 - 1)'
    },
    {
      name: 'num_inference_steps',
      type: 'number',
      value: 40,
      default: 40,
      min: 10,
      max: 50,
      step: 1,
      label: 'Inference Steps',
      description: 'Number of denoising steps (10-50)'
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
      description: 'How strongly the output should follow the prompt (1-20)'
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

const flux1KreaImageToImageNode: NodeInstance = NanoSDK.registerNode(nodeDefinition)

flux1KreaImageToImageNode.execute = async ({ inputs, parameters, context }) => {
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

  context.sendStatus({ type: 'running', message: 'Preparing input image...' })

  const imageDataUrl = await assetToDataUrl(imageUri)

  const numImages = clampNumber(Number(getParameterValue(parameters, 'num_images', 1)), 1, 4)
  const strength = clampNumber(Number(getParameterValue(parameters, 'strength', 0.95)), 0.01, 1)
  const numInferenceSteps = clampNumber(Math.round(Number(getParameterValue(parameters, 'num_inference_steps', 40))), 10, 50)
  const guidanceScale = clampNumber(Number(getParameterValue(parameters, 'guidance_scale', 4.5)), 1, 20)
  const seedValue = Number(getParameterValue(parameters, 'seed', -1))
  const requestedFormat = String(getParameterValue(parameters, 'output_format', 'jpeg'))
  const outputFormat = allowedFormats.has(requestedFormat) ? requestedFormat : 'jpeg'
  const requestedAcceleration = String(getParameterValue(parameters, 'acceleration', 'regular'))
  const acceleration = allowedAccelerations.has(requestedAcceleration) ? requestedAcceleration : 'regular'
  const syncMode = Boolean(getParameterValue(parameters, 'sync_mode', false))
  const enableSafetyChecker = Boolean(getParameterValue(parameters, 'enable_safety_checker', true))

  const payload: Record<string, unknown> = {
    prompt,
    image_url: imageDataUrl,
    num_images: numImages,
    strength,
    num_inference_steps: numInferenceSteps,
    guidance_scale: guidanceScale,
    output_format: outputFormat,
    acceleration,
    sync_mode: syncMode,
    enable_safety_checker: enableSafetyChecker
  }

  if (Number.isInteger(seedValue) && seedValue >= 0) {
    payload.seed = seedValue
  }

  const accelerationFactor = acceleration === 'high' ? 0.65 : acceleration === 'regular' ? 0.85 : 1
  const syncFactor = syncMode ? 1.2 : 1
  const stepFactor = numInferenceSteps / 40
  const expectedMs = Math.min(
    150000,
    Math.max(18000, Math.floor(numImages * 28000 * stepFactor * accelerationFactor * syncFactor))
  )

  const strategy = createProgressStrategy({
    expectedMs,
    inQueueMessage: 'Waiting for Flux-1 Krea image-to-image...',
    finalizingMessage: 'Finalizing images...',
    defaultInProgressMessage: (step) => `Processing step ${step}...`
  })

  try {
    let stepCount = 0

    const result = await fal.subscribe('fal-ai/flux-1/krea/image-to-image', {
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
    }) as Flux1KreaImageToImageResponse

    const responseData = (result as any)?.data ?? {}
    const directImages = Array.isArray(result.images) ? result.images : []
    const nestedImages = Array.isArray(responseData.images) ? responseData.images : []
    const images = (directImages.length ? directImages : nestedImages) as FalImageReference[]

    if (!images.length) {
      throw new Error('No images were returned by the Flux-1 Krea image-to-image API')
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
    const message = error?.message || 'Failed to run Flux-1 Krea image-to-image'
    context.sendStatus({ type: 'error', message })
    throw error
  }
}

export default flux1KreaImageToImageNode
