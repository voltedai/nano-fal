import { NanoSDK, NodeDefinition, NodeInstance } from '@nanograph/sdk'
import { QueueStatus } from '@fal-ai/client'
import { configureFalClient, fal } from '../../utils/fal-client.js'
import { createProgressStrategy } from '../../utils/progress-strategy.js'
import { getParameterValue } from '../../utils/parameter-utils.js'
import { FalImageReference, uploadGeneratedImages, assetToDataUrl } from '../flux-pro/utils.js'
import { imageSize } from 'image-size'
import { resolveAsset } from '@nanograph/sdk'

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
            name: 'guidance_scale',
            type: 'number',
            value: 4,
            default: 4,
            min: 0,
            max: 20,
            step: 0.1,
            label: 'Guidance Scale',
            description: 'Classifier Free Guidance scale'
        },
        {
            name: 'num_images',
            type: 'number',
            value: 1,
            default: 1,
            min: 1,
            max: 4,
            step: 1,
            label: 'Number of Images',
            description: 'The number of images to generate.'
        },
        {
            name: 'image_size',
            type: 'select',
            value: 'square_hd',
            default: 'square_hd',
            label: 'Image Size',
            description: 'The size of the generated image.',
            options: [
                { label: 'Square HD', value: 'square_hd' },
                { label: 'Square', value: 'square' },
                { label: 'Portrait 4:3', value: 'portrait_4_3' },
                { label: 'Portrait 16:9', value: 'portrait_16_9' },
                { label: 'Landscape 4:3', value: 'landscape_4_3' },
                { label: 'Landscape 16:9', value: 'landscape_16_9' },
                { label: 'Custom', value: 'custom' },
                { label: 'Source Image 1', value: 'source_image' }
            ]
        },
        {
            name: 'custom_width',
            type: 'number',
            value: 1024,
            default: 1024,
            min: 64,
            max: 14142,
            step: 8,
            label: 'Custom Width',
            description: 'Width for custom image size'
        },
        {
            name: 'custom_height',
            type: 'number',
            value: 1024,
            default: 1024,
            min: 64,
            max: 14142,
            step: 8,
            label: 'Custom Height',
            description: 'Height for custom image size'
        },
        {
            name: 'acceleration',
            type: 'select',
            value: 'regular',
            default: 'regular',
            label: 'Acceleration',
            description: 'Acceleration level for image generation.',
            options: [
                { label: 'None', value: 'none' },
                { label: 'Regular', value: 'regular' }
            ]
        },
        {
            name: 'output_format',
            type: 'select',
            value: 'png',
            default: 'png',
            label: 'Output Format',
            description: 'The format of the generated image.',
            options: [
                { label: 'PNG', value: 'png' },
                { label: 'JPEG', value: 'jpeg' }
            ]
        },
        {
            name: 'enable_safety_checker',
            type: 'boolean',
            value: true,
            default: true,
            label: 'Enable Safety Checker',
            description: 'If set to true, the safety checker will be enabled.'
        },
        {
            name: 'sync_mode',
            type: 'boolean',
            value: false,
            default: false,
            label: 'Sync Mode',
            description: 'Return inline images instead of URLs'
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
    const guidanceScale = Number(getParameterValue(parameters, 'guidance_scale', 4))
    const numImages = Number(getParameterValue(parameters, 'num_images', 1))
    const imageSizeParam = String(getParameterValue(parameters, 'image_size', 'square_hd'))
    const customWidth = Number(getParameterValue(parameters, 'custom_width', 1024))
    const customHeight = Number(getParameterValue(parameters, 'custom_height', 1024))
    const acceleration = String(getParameterValue(parameters, 'acceleration', 'regular'))

    let imageSizeValue: string | { width: number, height: number } = imageSizeParam

    if (imageSizeParam === 'custom') {
        imageSizeValue = { width: customWidth, height: customHeight }
    } else if (imageSizeParam === 'source_image') {
        if (!imageInputs[0]) {
            throw new Error('Source Image 1 selected for size but Key Image 1 is missing')
        }
        const buffer = await resolveAsset(imageInputs[0], { asBuffer: true }) as Buffer
        try {
            const dimensions = imageSize(buffer)
            if (!dimensions.width || !dimensions.height) {
                throw new Error('Could not calculate dimensions of Source Image 1')
            }
            imageSizeValue = { width: dimensions.width, height: dimensions.height }
            console.log(`Calculated source image size: ${dimensions.width}x${dimensions.height}`)
        } catch (e) {
            console.warn('Failed to calculate image size, falling back to square_hd', e)
            imageSizeValue = 'square_hd'
        }
    }

    const outputFormat = String(getParameterValue(parameters, 'output_format', 'png'))
    const enableSafetyChecker = Boolean(getParameterValue(parameters, 'enable_safety_checker', true))
    const syncMode = Boolean(getParameterValue(parameters, 'sync_mode', false))
    const seedValue = Number(getParameterValue(parameters, 'seed', -1))

    const payload: Record<string, unknown> = {
        prompt,
        image_urls: imageUrls,
        negative_prompt: negativePrompt,
        num_inference_steps: numInferenceSteps,
        guidance_scale: guidanceScale,
        num_images: numImages,
        image_size: imageSizeValue,
        acceleration,
        output_format: outputFormat,
        enable_safety_checker: enableSafetyChecker,
        sync_mode: syncMode
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
