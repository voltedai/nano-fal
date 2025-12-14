import { NanoSDK, NodeDefinition, NodeInstance } from '@nanograph/sdk'
import { QueueStatus } from '@fal-ai/client'
import { configureFalClient, fal } from '../../utils/fal-client.js'
import { createProgressStrategy } from '../../utils/progress-strategy.js'
import { getParameterValue } from '../../utils/parameter-utils.js'
import { FalImageReference, uploadGeneratedImages, assetToDataUrl } from '../flux-pro/utils.js'

interface QwenImageEditPlusResponse {
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
    uid: 'fal-ai-qwen-image-edit-plus',
    name: 'Qwen Image Edit Plus',
    category: 'Image Editing',
    version: '1.0.0',
    type: 'server',
    description: 'Edit images using Fal.ai Qwen Image Edit Plus model',
    inputs: [
        {
            name: 'prompt',
            type: 'string',
            description: 'The prompt used for generating the image.'
        },
        {
            name: 'image1',
            type: 'asset:image',
            description: 'Primary image to edit'
        },
        {
            name: 'image2',
            type: 'asset:image',
            description: 'Optional additional image to edit',
            optional: true
        },
        {
            name: 'image3',
            type: 'asset:image',
            description: 'Optional additional image to edit',
            optional: true
        },
        {
            name: 'image4',
            type: 'asset:image',
            description: 'Optional additional image to edit',
            optional: true
        },
        {
            name: 'negative_prompt',
            type: 'string',
            description: 'The negative prompt for the generation'
        }
    ],
    outputs: [
        {
            name: 'images',
            type: 'asset:image',
            description: 'The generated image files info.'
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
            value: 50,
            default: 50,
            min: 2,
            max: 100,
            step: 1,
            label: 'Num Inference Steps',
            description: 'The number of inference steps to perform.'
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

const qwenImageEditPlusNode: NodeInstance = NanoSDK.registerNode(nodeDefinition)

qwenImageEditPlusNode.execute = async ({ inputs, parameters, context }) => {
    configureFalClient()

    const prompt = inputs.prompt?.[0] as string
    const imageInputs = [
        inputs.image1?.[0] as string | undefined,
        inputs.image2?.[0] as string | undefined,
        inputs.image3?.[0] as string | undefined,
        inputs.image4?.[0] as string | undefined
    ].filter((uri): uri is string => Boolean(uri))

    const negativePrompt = (inputs.negative_prompt?.[0] as string) || ' '

    if (!prompt) {
        context.sendStatus({ type: 'error', message: 'Prompt is required' })
        throw new Error('Prompt is required')
    }

    if (imageInputs.length === 0) {
        context.sendStatus({ type: 'error', message: 'At least one image is required' })
        throw new Error('At least one image is required')
    }

    const imageUrls = await Promise.all(imageInputs.map(uri => assetToDataUrl(uri)))

    const numInferenceSteps = Number(getParameterValue(parameters, 'num_inference_steps', 50))
    const seedValue = Number(getParameterValue(parameters, 'seed', -1))

    const payload: Record<string, unknown> = {
        prompt,
        image_urls: imageUrls,
        negative_prompt: negativePrompt,
        num_inference_steps: numInferenceSteps
    }

    if (Number.isInteger(seedValue) && seedValue >= 0) {
        payload.seed = seedValue
    }

    // Estimation logic (rough guess)
    const expectedMs = Math.max(5000, imageUrls.length * 10000)

    const strategy = createProgressStrategy({
        expectedMs,
        inQueueMessage: 'Waiting for Qwen Image Edit Plus...',
        finalizingMessage: 'Finalizing images...',
        defaultInProgressMessage: (step) => `Processing step ${step}...`
    })

    try {
        let stepCount = 0

        const result = await fal.subscribe('fal-ai/qwen-image-edit-plus', {
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
        }) as QwenImageEditPlusResponse

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
        const message = error?.message || 'Failed to generate images with Qwen Image Edit Plus'
        context.sendStatus({ type: 'error', message })
        throw error
    }
}

export default qwenImageEditPlusNode
