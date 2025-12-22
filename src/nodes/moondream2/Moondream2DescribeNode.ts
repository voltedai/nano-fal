import { NanoSDK, NodeDefinition, NodeInstance } from '@nanograph/sdk'
import { QueueStatus } from '@fal-ai/client'
import { configureFalClient, fal } from '../../utils/fal-client.js'
import { createProgressStrategy } from '../../utils/progress-strategy.js'
import { loadImageAssetAsDataUrl } from './shared.js'

interface MoondreamDescribeResponse {
  data?: {
    output?: string
  }
  output?: string
}

const nodeDefinition: NodeDefinition = {
  uid: 'fal-moondream2-describe',
  name: 'Moondream 2 Describe',
  category: 'Moondream / Moondream 2',
  version: '1.0.0',
  type: 'server',
  description: 'Generates a natural language description for an image using Fal.ai Moondream 2',
  inputs: [
    {
      name: 'image',
      type: 'asset:image',
      description: 'Input image to analyze'
    }
  ],
  outputs: [
    {
      name: 'description',
      type: 'string',
      description: 'Model generated description of the image'
    }
  ],
  parameters: []
}

const moondreamDescribeNode: NodeInstance = NanoSDK.registerNode(nodeDefinition)

moondreamDescribeNode.execute = async ({ inputs, context }) => {
  configureFalClient()

  const image = inputs.image?.[0] as string

  if (!image) {
    const message = 'Input image is required'
    context.sendStatus({ type: 'error', message })
    throw new Error(message)
  }

  context.sendStatus({ type: 'running', message: 'Preparing image for analysis...' })

  try {
    const imageDataUrl = await loadImageAssetAsDataUrl(image)

    let stepCount = 0
    const strategy = createProgressStrategy({
      expectedMs: 12000,
      inQueueMessage: 'Waiting in queue...',
      finalizingMessage: 'Finalizing description...',
      defaultInProgressMessage: (n) => `Processing step ${n}...`
    })

    const result = await fal.subscribe('fal-ai/moondream2', {
      input: {
        image_url: imageDataUrl
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
    }) as MoondreamDescribeResponse

    const description = result.data?.output ?? result.output

    if (!description) {
      throw new Error('Moondream 2 did not return a description')
    }

    return {
      description: [description]
    }
  } catch (error: any) {
    const message = error?.message ?? 'Failed to generate description'
    context.sendStatus({ type: 'error', message })
    throw error
  }
}

export default moondreamDescribeNode
