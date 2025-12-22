import { NanoSDK, NodeDefinition, NodeInstance, resolveAsset } from '@nanograph/sdk'
import { QueueStatus } from '@fal-ai/client'
import { configureFalClient, fal } from '../../utils/fal-client.js'
import { createProgressStrategy } from '../../utils/progress-strategy.js'
import { getParameterValue } from '../../utils/parameter-utils.js'
import { FalImageReference, uploadGeneratedImages, assetToDataUrl } from '../flux-pro/utils.js'

interface Gemini3ProPreviewEditResponse {
    data?: {
        images?: FalImageReference[]
        description?: string
        timings?: Record<string, number>
    }
    images?: FalImageReference[]
    description?: string
    timings?: Record<string, number>
}

const nodeDefinition: NodeDefinition = {
    uid: 'fal-ai-gemini-3-pro-image-preview-edit',
    name: 'Gemini 3 Pro Preview Edit',
    category: 'Gemini / Gemini 3',
    version: '1.0.0',
    type: 'server',
    description: 'Edit images using Google Gemini 3 Pro',
    inputs: [
        {
            name: 'prompt',
            type: 'string',
            description: 'The prompt used for editing the image.'
        },
        {
            name: 'image1',
            type: 'asset:image',
            description: 'Primary image to edit'
        },
        {
            name: 'image2',
            type: 'asset:image',
            description: 'Optional additional image',
            optional: true
        },
        {
            name: 'image3',
            type: 'asset:image',
            description: 'Optional additional image',
            optional: true
        },
        {
            name: 'image4',
            type: 'asset:image',
            description: 'Optional additional image',
            optional: true
        }
    ],
    outputs: [
        {
            name: 'images',
            type: 'asset:image',
            description: 'The generated image files.'
        },
        {
            name: 'description',
            type: 'string',
            description: 'Description of the generated images.'
        }
    ],
    parameters: [
        {
            name: 'output_format',
            type: 'select',
            value: 'png',
            default: 'png',
            label: 'Output Format',
            description: 'The format of the generated image.',
            options: [
                { label: 'PNG', value: 'png' },
                { label: 'JPEG', value: 'jpeg' },
                { label: 'WebP', value: 'webp' }
            ]
        },
        {
            name: 'resolution',
            type: 'select',
            value: '1K',
            default: '1K',
            label: 'Resolution',
            description: 'The resolution of the image to generate.',
            options: [
                { label: '1K', value: '1K' },
                { label: '2K', value: '2K' },
                { label: '4K', value: '4K' }
            ]
        },
        {
            name: 'aspect_ratio',
            type: 'select',
            value: 'auto',
            default: 'auto',
            label: 'Aspect Ratio',
            description: 'The aspect ratio of the generated image.',
            options: [
                { label: 'Auto', value: 'auto' },
                { label: '21:9', value: '21:9' },
                { label: '16:9', value: '16:9' },
                { label: '3:2', value: '3:2' },
                { label: '4:3', value: '4:3' },
                { label: '5:4', value: '5:4' },
                { label: '1:1', value: '1:1' },
                { label: '4:5', value: '4:5' },
                { label: '3:4', value: '3:4' },
                { label: '2:3', value: '2:3' },
                { label: '9:16', value: '9:16' }
            ]
        },
        {
            name: 'limit_generations',
            type: 'boolean',
            value: false,
            default: false,
            label: 'Limit Generations',
            description: 'Limit the number of generations from each round of prompting to 1.'
        },
        {
            name: 'enable_web_search',
            type: 'boolean',
            value: false,
            default: false,
            label: 'Enable Web Search',
            description: 'Enable web search for the image generation task.'
        }
    ]
}

const gemini3PreviewEditNode: NodeInstance = NanoSDK.registerNode(nodeDefinition)

gemini3PreviewEditNode.execute = async ({ inputs, parameters, context }) => {
    configureFalClient()

    const prompt = inputs.prompt?.[0] as string

    if (!prompt) {
        context.sendStatus({ type: 'error', message: 'Prompt is required' })
        throw new Error('Prompt is required')
    }

    const imageInputs = [
        inputs.image1?.[0] as string | undefined,
        inputs.image2?.[0] as string | undefined,
        inputs.image3?.[0] as string | undefined,
        inputs.image4?.[0] as string | undefined
    ].filter((uri): uri is string => Boolean(uri))

    if (imageInputs.length === 0) {
        context.sendStatus({ type: 'error', message: 'At least one image is required' })
        throw new Error('At least one image is required')
    }

    const imageUrls = await Promise.all(imageInputs.map(uri => assetToDataUrl(uri)))

    const outputFormat = String(getParameterValue(parameters, 'output_format', 'png'))
    const resolution = String(getParameterValue(parameters, 'resolution', '1K'))
    const aspectRatio = String(getParameterValue(parameters, 'aspect_ratio', 'auto'))
    const limitGenerations = Boolean(getParameterValue(parameters, 'limit_generations', false))
    const enableWebSearch = Boolean(getParameterValue(parameters, 'enable_web_search', false))

    const payload = {
        prompt,
        image_urls: imageUrls,
        output_format: outputFormat,
        resolution,
        aspect_ratio: aspectRatio,
        limit_generations: limitGenerations,
        enable_web_search: enableWebSearch
    }

    const expectedMs = Math.max(10000, imageUrls.length * 5000)

    const strategy = createProgressStrategy({
        expectedMs,
        inQueueMessage: 'Waiting for Gemini Edit...',
        finalizingMessage: 'Finalizing images...',
        defaultInProgressMessage: (step) => `Processing step ${step}...`
    })

    try {
        let stepCount = 0

        const result = await fal.subscribe('fal-ai/gemini-3-pro-image-preview/edit', {
            input: payload,
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
        }) as unknown as Gemini3ProPreviewEditResponse

        console.log('Gemini 3 Edit Response:', JSON.stringify(result, null, 2))

        const images = result.images || result.data?.images || []

        if (!images.length) {
            throw new Error('No images were returned by the Gemini API')
        }

        const uploadedImages = await uploadGeneratedImages(images)

        return {
            images: uploadedImages,
            description: result.description ? [result.description] : (result.data?.description ? [result.data.description] : [])
        }

    } catch (error: any) {
        const message = error?.message || 'Failed to generate images with Gemini 3 Pro Edit'
        context.sendStatus({ type: 'error', message })
        throw error
    }
}

export default gemini3PreviewEditNode
