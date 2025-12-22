import { NanoSDK, NodeDefinition, NodeInstance, resolveAsset, uploadAsset } from '@nanograph/sdk'
import { QueueStatus } from '@fal-ai/client'
import { configureFalClient, fal } from '../../utils/fal-client.js'
import { getParameterValue } from '../../utils/parameter-utils.js'
import { createProgressStrategy } from '../../utils/progress-strategy.js'
import { uploadBufferToFal } from '../../utils/fal-storage.js'
import { generateAssetFilename } from '../../utils/asset-utils.js'
import { detectImageFormat, clamp } from './shared.js'

interface QwenMultipleAnglesResponse {
  images: Array<{
    url: string
  }>
  seed: number
}

const nodeDefinition: NodeDefinition = {
  uid: 'fal-qwen-multiple-angles',
  name: 'Qwen Multiple Angles',
  category: 'Qwen / Gallery',
  version: '1.0.0',
  type: 'server',
  description: 'Camera control with precise adjustments for multiple angles',
  inputs: [
    {
      name: 'image',
      type: 'asset:image',
      description: 'Image to adjust camera angle for'
    }
  ],
  outputs: [
    {
      name: 'images',
      type: 'asset:image',
      description: 'Images with adjusted camera angles'
    },
    {
      name: 'seed',
      type: 'number',
      description: 'Random seed used for generation'
    }
  ],
  parameters: [
    {
      name: 'num_images',
      type: 'number',
      value: 1,
      default: 1,
      label: 'Number of Images',
      description: 'Number of images to generate (1-4)',
      min: 1,
      max: 4
    },
    {
      name: 'vertical_angle',
      type: 'slider',
      value: 0,
      default: 0,
      label: 'Vertical Angle (Bird ⬄ Worm)',
      description: 'Adjust vertical camera angle (-1=bird\'s-eye view/looking down, 0=neutral, 1=worm\'s-eye view/looking up)',
      min: -1,
      max: 1,
      step: 0.1
    },
    {
      name: 'rotate_right_left',
      type: 'slider',
      value: 0,
      default: 0,
      label: 'Rotate Right-Left (degrees °)',
      description: 'Rotate camera left (positive) or right (negative) in degrees. Positive values rotate left, negative values rotate right',
      min: -90,
      max: 90
    },
    {
      name: 'move_forward',
      type: 'slider',
      value: 0,
      default: 0,
      label: 'Move Forward → Close-Up',
      description: 'Move camera forward (0=no movement, 10=close-up)',
      min: 0,
      max: 10
    },
    {
      name: 'wide_angle_lens',
      type: 'boolean',
      value: false,
      default: false,
      label: 'Wide-Angle Lens',
      description: 'Enable wide-angle lens effect'
    },
    {
      name: 'lora_scale',
      type: 'number',
      value: 1.25,
      default: 1.25,
      label: 'LoRA Scale',
      description: 'Scale factor for the LoRA model (0-4). Controls the strength of the camera control effect',
      min: 0,
      max: 4
    },
    {
      name: 'image_size',
      type: 'select',
      value: 'auto',
      default: 'auto',
      label: 'Image Size',
      description: 'Size preset for the generated image',
      options: [
        { label: 'Auto (use input size)', value: 'auto' },
        { label: 'Square HD', value: 'square_hd' },
        { label: 'Square', value: 'square' },
        { label: 'Portrait 4:3', value: 'portrait_4_3' },
        { label: 'Portrait 16:9', value: 'portrait_16_9' },
        { label: 'Landscape 4:3', value: 'landscape_4_3' },
        { label: 'Landscape 16:9', value: 'landscape_16_9' }
      ]
    },
    {
      name: 'image_width',
      type: 'number',
      value: 512,
      default: 512,
      label: 'Image Width',
      description: 'Custom width (only if image_size is not set)',
      min: 1,
      max: 14142
    },
    {
      name: 'image_height',
      type: 'number',
      value: 512,
      default: 512,
      label: 'Image Height',
      description: 'Custom height (only if image_size is not set)',
      min: 1,
      max: 14142
    },
    {
      name: 'guidance_scale',
      type: 'number',
      value: 1,
      default: 1,
      label: 'Guidance Scale',
      description: 'CFG scale (0-20). Controls how closely the model follows the prompt',
      min: 0,
      max: 20
    },
    {
      name: 'num_inference_steps',
      type: 'number',
      value: 6,
      default: 6,
      label: 'Inference Steps',
      description: 'Number of inference steps (2-50)',
      min: 2,
      max: 50
    },
    {
      name: 'acceleration',
      type: 'select',
      value: 'regular',
      default: 'regular',
      label: 'Acceleration',
      description: 'Acceleration level for image generation',
      options: [
        { label: 'None', value: 'none' },
        { label: 'Regular', value: 'regular' }
      ]
    },
    {
      name: 'negative_prompt',
      type: 'text',
      value: ' ',
      default: ' ',
      label: 'Negative Prompt',
      description: 'Negative prompt for the generation'
    },
    {
      name: 'output_format',
      type: 'select',
      value: 'png',
      default: 'png',
      label: 'Output Format',
      description: 'Format of the output image',
      options: [
        { label: 'PNG', value: 'png' },
        { label: 'JPEG', value: 'jpeg' },
        { label: 'WebP', value: 'webp' }
      ]
    },
    {
      name: 'enable_safety_checker',
      type: 'boolean',
      value: true,
      default: true,
      label: 'Enable Safety Checker',
      description: 'Whether to enable the safety checker'
    },
    {
      name: 'seed',
      type: 'number',
      value: -1,
      default: -1,
      label: 'Seed',
      description: 'Random seed for reproducibility (-1 for random)'
    }
  ]
}

const qwenMultipleAnglesNode: NodeInstance = NanoSDK.registerNode(nodeDefinition)

qwenMultipleAnglesNode.execute = async ({ inputs, parameters, context }) => {
  configureFalClient()

  const imageInput = inputs.image?.[0] as string | undefined

  if (!imageInput) {
    context.sendStatus({ type: 'error', message: 'Image is required' })
    throw new Error('Image is required')
  }

  const numImages = clamp(Number(getParameterValue(parameters, 'num_images', 1)), 1, 4)
  const verticalAngle = clamp(Number(getParameterValue(parameters, 'vertical_angle', 0)), -1, 1)
  const rotateRightLeft = clamp(Number(getParameterValue(parameters, 'rotate_right_left', 0)), -90, 90)
  const moveForward = clamp(Number(getParameterValue(parameters, 'move_forward', 0)), 0, 10)
  const wideAngleLens = Boolean(getParameterValue(parameters, 'wide_angle_lens', false))
  const loraScale = clamp(Number(getParameterValue(parameters, 'lora_scale', 1.25)), 0, 4)
  const imageSizeValue = String(getParameterValue(parameters, 'image_size', 'auto'))
  const imageWidth = Number(getParameterValue(parameters, 'image_width', 512))
  const imageHeight = Number(getParameterValue(parameters, 'image_height', 512))
  const guidanceScale = clamp(Number(getParameterValue(parameters, 'guidance_scale', 1)), 0, 20)
  const numInferenceSteps = clamp(Number(getParameterValue(parameters, 'num_inference_steps', 6)), 2, 50)
  const acceleration = String(getParameterValue(parameters, 'acceleration', 'regular'))
  const negativePrompt = String(getParameterValue(parameters, 'negative_prompt', ' '))
  const outputFormat = String(getParameterValue(parameters, 'output_format', 'png'))
  const enableSafetyChecker = Boolean(getParameterValue(parameters, 'enable_safety_checker', true))
  const seedValue = Number(getParameterValue(parameters, 'seed', -1))

  context.sendStatus({ type: 'running', message: 'Preparing input image...' })

  try {
    const buffer: Buffer = await resolveAsset(imageInput, { asBuffer: true }) as Buffer
    const format = detectImageFormat(buffer)
    const uploadedUrl = await uploadBufferToFal(buffer, format, { filenamePrefix: 'qwen-multiple-angles-input' })

    const payload: any = {
      image_urls: [uploadedUrl],
      num_images: numImages,
      vertical_angle: verticalAngle,
      rotate_right_left: rotateRightLeft,
      move_forward: moveForward,
      wide_angle_lens: wideAngleLens,
      lora_scale: loraScale,
      guidance_scale: guidanceScale,
      num_inference_steps: numInferenceSteps,
      acceleration,
      negative_prompt: negativePrompt,
      output_format: outputFormat,
      enable_safety_checker: enableSafetyChecker
    }

    if (imageSizeValue !== 'auto') {
      payload.image_size = imageSizeValue
    } else {
      payload.image_size = {
        width: imageWidth,
        height: imageHeight
      }
    }

    if (Number.isInteger(seedValue) && seedValue >= 0) {
      payload.seed = seedValue
    }

    let stepCount = 0
    const expectedMs = Math.min(180000, Math.max(20000, numImages * 9000))
    const strategy = createProgressStrategy({
      expectedMs,
      inQueueMessage: 'Waiting in queue...',
      finalizingMessage: 'Finalizing angle adjustment...',
      defaultInProgressMessage: (n) => `Processing step ${n}...`
    })

    const result = await fal.subscribe('fal-ai/qwen-image-edit-plus-lora-gallery/multiple-angles', {
      input: payload,
      logs: true,
      onQueueUpdate: (status: QueueStatus) => {
        if (status.status === 'IN_QUEUE') {
          const r = strategy.onQueue()
          context.sendStatus({ type: 'running', message: r.message, progress: r.progress })
        } else if (status.status === 'IN_PROGRESS') {
          stepCount++
          const r = strategy.onProgress(status, stepCount)
          context.sendStatus({ type: 'running', message: r.message, progress: r.progress })
        } else if (status.status === 'COMPLETED') {
          const r = strategy.onCompleted()
          context.sendStatus({ type: 'running', message: r.message, progress: r.progress })
        }
      }
    }) as unknown as QwenMultipleAnglesResponse

    // Check both result.images and result.data.images
    const directImages = result.images
    const dataImages = (result as any)?.data?.images
    const images = directImages ?? dataImages ?? []

    if (!images.length) {
      throw new Error('No images were returned by the Qwen Multiple Angles API')
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
        throw new Error('Failed to upload generated image')
      }

      uploadedUris.push(uploadResult.uri)
    }

    if (!uploadedUris.length) {
      throw new Error('Generated images could not be retrieved')
    }

    return {
      images: uploadedUris,
      seed: result.seed ? [result.seed] : []
    }
  } catch (error: any) {
    const message = error?.message ?? 'Failed to adjust camera angles'
    context.sendStatus({ type: 'error', message })
    throw error
  }
}

export default qwenMultipleAnglesNode

