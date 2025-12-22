import { NanoSDK, NodeDefinition, NodeInstance, resolveAsset, uploadAsset } from '@nanograph/sdk'
import { QueueStatus } from '@fal-ai/client'
import { configureFalClient, fal } from '../../utils/fal-client.js'
import { getParameterValue } from '../../utils/parameter-utils.js'
import { createProgressStrategy } from '../../utils/progress-strategy.js'
import { uploadBufferToFal } from '../../utils/fal-storage.js'

const detectImageFormat = (buffer: Buffer): string => {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'jpeg'
  }
  if (
    buffer.length >= 8 &&
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
    buffer.length >= 6 &&
    buffer[0] === 0x47 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x38 &&
    (buffer[4] === 0x39 || buffer[4] === 0x37) &&
    buffer[5] === 0x61
  ) {
    return 'gif'
  }
  return 'jpeg'
}

interface GeminiFlashEditMultiImage {
  url?: string
  content_type?: string
  file_name?: string
  file_size?: number
  width?: number
  height?: number
}

interface GeminiFlashEditMultiResponse {
  data?: {
    image?: GeminiFlashEditMultiImage
    description?: string
  }
  image?: GeminiFlashEditMultiImage
  description?: string
}

const nodeDef: NodeDefinition = {
  uid: 'gemini-flash-edit-multi',
  name: 'Gemini Flash Edit Multi',
  category: 'Fal AI / Gemini / Gemini Flash',
  version: '1.0.0',
  type: 'server',
  description: 'Edits multiple images using text prompts and reference images with Gemini Flash Edit Multi',
  inputs: [
    {
      name: 'prompt',
      type: 'string',
      description: 'Text prompt describing the image edits to apply'
    },
    {
      name: 'image1',
      type: 'asset:image',
      description: 'First image as asset URI',
      optional: true
    },
    {
      name: 'image2',
      type: 'asset:image',
      description: 'Second image as asset URI',
      optional: true
    },
    {
      name: 'image3',
      type: 'asset:image',
      description: 'Third image as asset URI',
      optional: true
    },
    {
      name: 'image4',
      type: 'asset:image',
      description: 'Fourth image as asset URI',
      optional: true
    }
  ],
  outputs: [
    {
      name: 'edited_image',
      type: 'asset:image',
      description: 'Edited image as asset URI'
    },
    {
      name: 'description',
      type: 'string',
      description: 'Text description or response from Gemini'
    }
  ],
  parameters: []
}

const geminiFlashEditMultiNode: NodeInstance = NanoSDK.registerNode(nodeDef)

geminiFlashEditMultiNode.execute = async ({ inputs, parameters, context }) => {
  // Configure Fal client
  configureFalClient()

  const prompt = inputs.prompt?.[0] as string
  const image1 = inputs.image1?.[0] as string
  const image2 = inputs.image2?.[0] as string
  const image3 = inputs.image3?.[0] as string
  const image4 = inputs.image4?.[0] as string

  if (!prompt) {
    context.sendStatus({ type: 'error', message: 'Prompt is required' })
    throw new Error('Prompt is required')
  }

  // Collect all provided images
  const inputImages = [image1, image2, image3, image4].filter(img => img !== undefined)

  if (inputImages.length === 0) {
    context.sendStatus({ type: 'error', message: 'At least one input image is required' })
    throw new Error('At least one input image is required')
  }

  context.sendStatus({ type: 'running', message: 'Processing input images...' })

  try {
    const inputImageUrls: string[] = []

    for (let i = 0; i < inputImages.length; i++) {
      const imageBuffer: Buffer = await resolveAsset(inputImages[i], { asBuffer: true }) as Buffer
      const format = detectImageFormat(imageBuffer)
      const uploadedUrl = await uploadBufferToFal(imageBuffer, format, { filenamePrefix: `gemini-flash-input-${i + 1}` })
      inputImageUrls.push(uploadedUrl)

      context.sendStatus({
        type: 'running',
        message: `Uploaded image ${i + 1}/${inputImages.length}`,
        progress: { step: (i + 1) * 20, total: 100 }
      })
    }

    console.log(`Uploaded ${inputImageUrls.length} input images to Fal storage`)

    let stepCount = 0
    const expectedMs = 25000
    const strategy = createProgressStrategy({
      expectedMs,
      inQueueMessage: 'Waiting in queue...',
      finalizingMessage: 'Finalizing...',
      defaultInProgressMessage: (n) => `Processing step ${n}...`
    })
    const result = await fal.subscribe('fal-ai/gemini-flash-edit/multi', {
      input: {
        prompt,
        input_image_urls: inputImageUrls
      },
      logs: true,
      onQueueUpdate: (status: QueueStatus) => {
        if (status.status === 'IN_QUEUE') {
          const r = strategy.onQueue()
          // Keep pre-processing indication (we used ~20% for inputs) if larger
          const start = Math.max(30, r.progress.step)
          context.sendStatus({ type: 'running', message: r.message, progress: { step: start, total: 100 } })
        } else if (status.status === 'IN_PROGRESS') {
          stepCount++
          const r = strategy.onProgress(status, stepCount)
          context.sendStatus({ type: 'running', message: r.message, progress: r.progress })
        } else if (status.status === 'COMPLETED') {
          const r = strategy.onCompleted()
          context.sendStatus({ type: 'running', message: r.message, progress: r.progress })
        }
      }
    }) as GeminiFlashEditMultiResponse

    if (!result.data || !result.data.image || !result.data.image.url) {
      throw new Error('No edited image was generated')
    }

    // Log the full response for debugging
    console.log('Full API response:', JSON.stringify(result.data, null, 2))

    // Get the edited image URL, fetch it and upload as asset
    const imageUrl = result.data.image.url
    console.log('Generated edited image URL:', imageUrl)

    const response = await fetch(imageUrl)
    const arrayBuffer = await response.arrayBuffer()
    const buffer = Buffer.from(arrayBuffer)

    console.log('Uploading edited image as asset...')
    const uploadResult = await uploadAsset(buffer, {
      type: 'image',
    })

    if (!uploadResult.uri) {
      throw new Error('Failed to upload generated image')
    }

    console.log('Upload successful, URI:', uploadResult.uri)
    console.log('Gemini description:', result.data.description)

    return {
      edited_image: [uploadResult.uri],
      description: [result.data.description || '']
    }
  } catch (error: any) {
    context.sendStatus({ type: 'error', message: error.message || 'Failed to edit images' })
    throw error
  }
}

export default geminiFlashEditMultiNode 
