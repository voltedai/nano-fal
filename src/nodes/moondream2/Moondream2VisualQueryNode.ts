import { NanoSDK, NodeDefinition, NodeInstance } from '@nanograph/sdk'
import { QueueStatus } from '@fal-ai/client'
import { configureFalClient, fal } from '../../utils/fal-client.js'
import { createProgressStrategy } from '../../utils/progress-strategy.js'
import { loadImageAssetAsDataUrl } from './shared.js'

interface MoondreamVisualQueryResponse {
  data?: {
    output?: string
  }
  output?: string
}

const nodeDefinition: NodeDefinition = {
  uid: 'fal-moondream2-visual-query',
  name: 'Moondream 2 Visual Query',
  category: 'Moondream / Moondream 2',
  version: '1.0.0',
  type: 'server',
  description: 'Answers questions about an image using Fal.ai Moondream 2 visual query endpoint',
  inputs: [
    {
      name: 'prompt',
      type: 'string',
      description: 'Question to ask about the image'
    },
    {
      name: 'image',
      type: 'asset:image',
      description: 'Input image to analyze'
    }
  ],
  outputs: [
    {
      name: 'answer',
      type: 'string',
      description: 'Model answer to the question'
    }
  ],
  parameters: []
}

const moondreamVisualQueryNode: NodeInstance = NanoSDK.registerNode(nodeDefinition)

moondreamVisualQueryNode.execute = async ({ inputs, context }) => {
  configureFalClient()

  const prompt = inputs.prompt?.[0] as string
  const image = inputs.image?.[0] as string

  if (!prompt) {
    const message = 'Prompt is required'
    context.sendStatus({ type: 'error', message })
    throw new Error(message)
  }

  if (!image) {
    const message = 'Input image is required'
    context.sendStatus({ type: 'error', message })
    throw new Error(message)
  }

  context.sendStatus({ type: 'running', message: 'Preparing image and question...' })

  try {
    const imageDataUrl = await loadImageAssetAsDataUrl(image)

    let stepCount = 0
    const strategy = createProgressStrategy({
      expectedMs: 15000,
      inQueueMessage: 'Waiting in queue...',
      finalizingMessage: 'Finalizing answer...',
      defaultInProgressMessage: (n) => `Processing step ${n}...`
    })

    const result = await fal.subscribe('fal-ai/moondream2/visual-query', {
      input: {
        image_url: imageDataUrl,
        prompt
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
    }) as MoondreamVisualQueryResponse

    const answer = result.data?.output ?? result.output

    if (!answer) {
      throw new Error('Moondream 2 did not return an answer')
    }

    return {
      answer: [answer]
    }
  } catch (error: any) {
    const message = error?.message ?? 'Failed to answer visual query'
    context.sendStatus({ type: 'error', message })
    throw error
  }
}

export default moondreamVisualQueryNode
