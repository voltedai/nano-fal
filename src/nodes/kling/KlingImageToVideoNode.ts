import { NanoSDK, NodeDefinition, NodeInstance, resolveAsset, uploadAsset } from '@nanograph/sdk'
import { QueueStatus } from '@fal-ai/client'
import { configureFalClient, fal } from '../../utils/fal-client.js'
import { getParameterValue } from '../../utils/parameter-utils.js'
import { createProgressStrategy } from '../../utils/progress-strategy.js'
import { uploadBufferToFal } from '../../utils/fal-storage.js'
import { generateVideoFilename } from '../../utils/asset-utils.js'

interface KlingVideoResponse {
  data: {
    video: {
      url: string
    }
  }
}

const nodeDef: NodeDefinition = {
  uid: 'kling-image-to-video',
  name: 'Kling Image to Video',
  category: 'Kling',
  version: '1.0.0',
  type: 'server',
  description: 'Generates videos from images using Fal.ai Kling 2.1 Master model',
  inputs: [
    {
      name: 'prompt',
      type: 'string',
      description: 'Text prompt describing the video to generate'
    },
    {
      name: 'negative_prompt',
      type: 'string',
      description: 'What to avoid in the generated video (optional)',
      optional: true
    },
    {
      name: 'image',
      type: 'asset:image',
      description: 'Input image as asset URI'
    }
  ],
  outputs: [
    {
      name: 'video',
      type: 'asset:video',
      description: 'Generated video as asset URI'
    }
  ],
  parameters: [
    {
      name: 'duration',
      type: 'select',
      value: '5',
      default: '5',
      label: 'Duration',
      description: 'Duration of the generated video in seconds',
      options: [
        { label: '5 seconds', value: '5' },
        { label: '10 seconds', value: '10' }
      ]
    },
    {
      name: 'cfg_scale',
      type: 'number',
      value: 0.5,
      default: 0.5,
      label: 'CFG Scale',
      description: 'How closely to follow the prompt (higher = more faithful)',
      min: 0.1,
      max: 2.0
    }
  ]
}

const klingImageToVideoNode: NodeInstance = NanoSDK.registerNode(nodeDef)

klingImageToVideoNode.execute = async ({ inputs, parameters, context }) => {
  // Configure Fal client
  configureFalClient()

  const prompt = inputs.prompt?.[0] as string
  const negative_prompt = inputs.negative_prompt?.[0] as string
  const image = inputs.image?.[0] as string

  if (!prompt) {
    context.sendStatus({ type: 'error', message: 'Prompt is required' })
    throw new Error('Prompt is required')
  }

  if (!image) {
    context.sendStatus({ type: 'error', message: 'Input image is required' })
    throw new Error('Input image is required')
  }

  // Get parameters
  const duration = getParameterValue(parameters, 'duration', '5')
  const cfg_scale = getParameterValue(parameters, 'cfg_scale', 0.5)

  context.sendStatus({ type: 'running', message: 'Starting video generation...' })

  try {
    // Resolve input image asset
    const imageBuffer: Buffer = await resolveAsset(image, { asBuffer: true }) as Buffer
    const imageUrl = await uploadBufferToFal(imageBuffer, 'jpeg', { filenamePrefix: 'kling-source' })

    console.log('Uploaded input image to Fal storage:', imageUrl)

    let stepCount = 0
    const expectedMs = Number(duration) === 10 ? 90000 : 60000
    const strategy = createProgressStrategy({
      expectedMs,
      inQueueMessage: 'Waiting in queue...',
      finalizingMessage: 'Finalizing...',
      defaultInProgressMessage: (n) => `Processing step ${n}...`
    })
    const result = await fal.subscribe('fal-ai/kling-video/v2.1/master/image-to-video', {
      input: {
        prompt,
        image_url: imageUrl,
        duration,
        cfg_scale,
        negative_prompt: negative_prompt || 'blur, distort, and low quality'
      },
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
    }) as KlingVideoResponse

    if (!result.data || !result.data.video || !result.data.video.url) {
      throw new Error('No video was generated')
    }

    // Get the video URL, fetch it and upload as asset
    const videoUrl = result.data.video.url
    console.log('Generated video URL:', videoUrl)

    const response = await fetch(videoUrl)
    const contentType = response.headers.get('content-type')
    const arrayBuffer = await response.arrayBuffer()
    const buffer = Buffer.from(arrayBuffer)

    const filename = generateVideoFilename(videoUrl, contentType)

    const uploadResult = await uploadAsset(buffer, { type: 'video', filename })

    if (!uploadResult.uri) {
      throw new Error('Failed to upload generated video')
    }

    console.log('Upload successful, URI:', uploadResult.uri)

    return {
      video: [uploadResult.uri]
    }
  } catch (error: any) {
    context.sendStatus({ type: 'error', message: error.message || 'Failed to generate video' })
    throw error
  }
}

export default klingImageToVideoNode 
