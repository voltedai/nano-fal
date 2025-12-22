import { NanoSDK, NodeDefinition, NodeInstance, resolveAsset, uploadAsset } from '@nanograph/sdk'
import { generateVideoFilename } from '../../utils/asset-utils.js'
import { QueueStatus } from '@fal-ai/client'
import { configureFalClient, fal } from '../../utils/fal-client.js'
import { getParameterValue } from '../../utils/parameter-utils.js'
import { createProgressStrategy } from '../../utils/progress-strategy.js'
import { ensureOption, uploadBufferAsImageUrl } from './utils.js'

interface Veo31ReferenceToVideoResponse {
  data?: {
    video?: {
      url?: string
    }
  }
}

const RESOLUTIONS = ['720p', '1080p'] as const
const DURATIONS = ['8s'] as const

const nodeDefinition: NodeDefinition = {
  uid: 'fal-veo31-reference-to-video',
  name: 'Veo 3.1 Reference to Video',
  category: 'Veo / Veo 3.1',
  version: '1.0.0',
  type: 'server',
  description: 'Generates subject-consistent videos from multiple reference images using Fal.ai Veo 3.1',
  inputs: [
    {
      name: 'prompt',
      type: 'string',
      description: 'Text prompt describing the desired motion and story'
    },
    {
      name: 'reference_image1',
      type: 'asset:image',
      description: 'First reference image as asset URI'
    },
    {
      name: 'reference_image2',
      type: 'asset:image',
      description: 'Second reference image as asset URI',
      optional: true
    },
    {
      name: 'reference_image3',
      type: 'asset:image',
      description: 'Third reference image as asset URI',
      optional: true
    },
    {
      name: 'reference_image4',
      type: 'asset:image',
      description: 'Fourth reference image as asset URI',
      optional: true
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
      name: 'resolution',
      type: 'select',
      value: '720p',
      default: '720p',
      label: 'Resolution',
      description: 'Rendering resolution',
      options: [
        { label: '720p', value: '720p' },
        { label: '1080p', value: '1080p' }
      ]
    },
    {
      name: 'duration',
      type: 'select',
      value: '8s',
      default: '8s',
      label: 'Duration',
      description: 'Clip duration (currently fixed at 8 seconds)',
      options: [
        { label: '8 seconds', value: '8s' }
      ]
    },
    {
      name: 'generate_audio',
      type: 'boolean',
      value: true,
      default: true,
      label: 'Generate Audio',
      description: 'Include automatically generated audio narration in the output'
    }
  ]
}

const veo31ReferenceToVideoNode: NodeInstance = NanoSDK.registerNode(nodeDefinition)

veo31ReferenceToVideoNode.execute = async ({ inputs, parameters, context }) => {
  configureFalClient()

  const prompt = inputs.prompt?.[0] as string
  const references = [
    inputs.reference_image1?.[0] as string | undefined,
    inputs.reference_image2?.[0] as string | undefined,
    inputs.reference_image3?.[0] as string | undefined,
    inputs.reference_image4?.[0] as string | undefined
  ].filter((uri): uri is string => Boolean(uri))

  if (!prompt) {
    context.sendStatus({ type: 'error', message: 'Prompt is required' })
    throw new Error('Prompt is required')
  }

  if (references.length === 0) {
    context.sendStatus({ type: 'error', message: 'At least one reference image is required' })
    throw new Error('At least one reference image is required')
  }

  const resolutionValue = getParameterValue<string>(parameters, 'resolution', '720p')
  const durationValue = getParameterValue<string>(parameters, 'duration', '8s')
  const generateAudioValue = getParameterValue<boolean>(parameters, 'generate_audio', true)

  const resolution = ensureOption(resolutionValue, RESOLUTIONS, '720p')
  const duration = ensureOption(durationValue, DURATIONS, '8s')
  const generate_audio = Boolean(generateAudioValue)

  context.sendStatus({ type: 'running', message: 'Uploading reference images for Veo 3.1...' })

  const referenceBuffers = await Promise.all(
    references.map((uri) => resolveAsset(uri, { asBuffer: true }) as Promise<Buffer>)
  )

  const image_urls = await Promise.all(
    referenceBuffers.map((buffer, index) =>
      uploadBufferAsImageUrl(buffer, `veo31-reference-${index + 1}`)
    )
  )

  const endpoint = 'fal-ai/veo3.1/reference-to-video'

  const payload = {
    prompt,
    image_urls,
    resolution,
    duration,
    generate_audio
  }

  try {
    let stepCount = 0
    let expectedMs = 130000
    if (resolution === '1080p') expectedMs += 30000
    if (generate_audio) expectedMs += 5000
    const strategy = createProgressStrategy({
      expectedMs,
      inQueueMessage: 'Waiting in queue...',
      finalizingMessage: 'Finalizing video...',
      defaultInProgressMessage: (n) => `Refining reference alignment ${n}...`
    })

    const result = await fal.subscribe(endpoint, {
      input: payload,
      logs: true,
      onQueueUpdate: (status: QueueStatus) => {
        try {
          console.log('[Veo31ReferenceToVideo] Queue update:', JSON.stringify(status))
        } catch { }

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
    }) as Veo31ReferenceToVideoResponse

    const videoUrl = result.data?.video?.url

    if (!videoUrl) {
      throw new Error('No video was generated by Veo 3.1')
    }

    const response = await fetch(videoUrl)
    const contentType = response.headers.get('content-type')
    const arrayBuffer = await response.arrayBuffer()
    const buffer = Buffer.from(arrayBuffer)

    const filename = generateVideoFilename(videoUrl, contentType)
    const uploadResult = await uploadAsset(buffer, { type: 'video', filename })

    if (!uploadResult?.uri) {
      throw new Error('Failed to upload generated video')
    }

    return {
      video: [uploadResult.uri]
    }
  } catch (error: any) {
    const message = error?.message || 'Failed to generate reference-driven video'
    context.sendStatus({ type: 'error', message })
    throw error
  }
}

export default veo31ReferenceToVideoNode
