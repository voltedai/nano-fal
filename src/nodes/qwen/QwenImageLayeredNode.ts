import { NanoSDK, NodeDefinition, NodeInstance } from '@nanograph/sdk'
import { QueueStatus } from '@fal-ai/client'
import { configureFalClient, fal } from '../../utils/fal-client.js'
import { createProgressStrategy } from '../../utils/progress-strategy.js'
import { getParameterValue } from '../../utils/parameter-utils.js'
import { FalImageReference, uploadGeneratedImages, assetToDataUrl } from '../flux-pro/utils.js'

interface QwenImageLayeredResponse {
    images?: FalImageReference[]
    seed?: number
    has_nsfw_concepts?: boolean[]
    timings?: Record<string, number>
    prompt?: string
    data?: {
        images?: FalImageReference[]
        seed?: number
        has_nsfw_concepts?: boolean[]
        timings?: Record<string, number>
        prompt?: string
    }
}

const nodeDefinition: NodeDefinition = {
    uid: 'fal-ai-qwen-image-layered',
    name: 'Qwen Image Layered',
    category: 'Image Editing',
    version: '1.0.0',
    type: 'server',
    description: 'Generate layered variations of an image using Qwen Image Layered',
    inputs: [
        {
            name: 'image',
            type: 'asset:image',
            description: 'Input image to process'
        },
        {
            name: 'prompt',
            type: 'string',
            description: 'The prompt used for generating the image.',
            optional: true
        },
        {
            name: 'negative_prompt',
            type: 'string',
            description: 'The negative prompt for the generation',
            optional: true
        }
    ],
    outputs: [
        {
            name: 'images',
            type: 'asset:image',
            description: 'The generated layered images.'
        },
        {
            name: 'seed',
            type: 'number',
            description: 'Seed of the generated Image.'
        },
        {
            name: 'has_nsfw_concepts',
            type: 'boolean',
            description: 'Whether the generated images contain NSFW concepts.'
        }
    ],
    parameters: [
        {
            name: 'num_inference_steps',
            type: 'number',
            value: 28,
            default: 28,
            min: 1,
            max: 50,
            step: 1,
            label: 'Num Inference Steps',
            description: 'The number of inference steps to perform.'
        },
        {
            name: 'guidance_scale',
            type: 'number',
            value: 5,
            default: 5,
            min: 1,
            max: 20,
            step: 0.1,
            label: 'Guidance Scale',
            description: 'The guidance scale to use for the image generation.'
        },
        {
            name: 'seed',
            type: 'number',
            value: -1,
            default: -1,
            min: -1,
            step: 1,
            label: 'Seed (-1 = random)',
            description: 'Seed of the generated Image.'
        }
    ]
}

const qwenImageLayeredNode: NodeInstance = NanoSDK.registerNode(nodeDefinition)

qwenImageLayeredNode.execute = async ({ inputs, parameters, context }) => {
    configureFalClient()

    const imageInput = inputs.image?.[0] as string | undefined

    if (!imageInput) {
        context.sendStatus({ type: 'error', message: 'Image is required' })
        throw new Error('Image is required')
    }

    const prompt = (inputs.prompt?.[0] as string) || 'describe this image'
    const negativePrompt = (inputs.negative_prompt?.[0] as string) || ''

    const imageUrl = await assetToDataUrl(imageInput)

    const numInferenceSteps = Number(getParameterValue(parameters, 'num_inference_steps', 28))
    const guidanceScale = Number(getParameterValue(parameters, 'guidance_scale', 5))
    const seedValue = Number(getParameterValue(parameters, 'seed', -1))

    const payload: Record<string, unknown> = {
        image_url: imageUrl,
        prompt,
        negative_prompt: negativePrompt,
        num_inference_steps: numInferenceSteps,
        guidance_scale: guidanceScale,
    }

    if (Number.isInteger(seedValue) && seedValue >= 0) {
        payload.seed = seedValue
    }

    // Estimation logic (rough guess) - layered might take a bit longer
    const expectedMs = 15000

    const strategy = createProgressStrategy({
        expectedMs,
        inQueueMessage: 'Waiting for Qwen Image Layered...',
        finalizingMessage: 'Finalizing images...',
        defaultInProgressMessage: (step) => `Processing step ${step}...`
    })

    try {
        let stepCount = 0

        const result = await fal.subscribe('fal-ai/qwen-image-layered', {
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
        }) as QwenImageLayeredResponse

        const images = result.images || result.data?.images || []

        if (!images.length) {
            throw new Error('No images were returned by the Qwen API')
        }

        const uploadedImages = await uploadGeneratedImages(images)

        return {
            images: uploadedImages,
            seed: typeof result.seed === 'number' ? [result.seed] : (typeof result.data?.seed === 'number' ? [result.data.seed] : []),
            has_nsfw_concepts: result.has_nsfw_concepts || result.data?.has_nsfw_concepts || []
        }
    } catch (error: any) {
        const message = error?.message || 'Failed to generate images with Qwen Image Layered'
        context.sendStatus({ type: 'error', message })
        throw error
    }
}

export default qwenImageLayeredNode
