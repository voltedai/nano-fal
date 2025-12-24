import { NanoSDK, NodeDefinition, NodeInstance, resolveAsset, uploadAsset } from '@nanograph/sdk';
import { QueueStatus } from '@fal-ai/client';
import { configureFalClient, fal } from '../../utils/fal-client.js';
import { getParameterValue } from '../../utils/parameter-utils.js';
import { generateAssetFilename } from '../../utils/asset-utils.js';
import { createProgressStrategy } from '../../utils/progress-strategy.js';
import sharp from 'sharp';

interface Sam3ImageResponse {
    data?: {
        image?: {
            url?: string;
            content_type?: string;
            file_size?: number;
            width?: number;
            height?: number;
        };
        masks?: Array<{
            url?: string;
            content_type?: string;
            width?: number;
            height?: number;
        }>;
    };
    image?: {
        url?: string;
        content_type?: string;
        file_size?: number;
        width?: number;
        height?: number;
    };
    masks?: Array<{
        url?: string;
        content_type?: string;
        width?: number;
        height?: number;
    }>;
}

const nodeDefinition: NodeDefinition = {
    uid: 'fal-ai/sam-3/image',
    name: 'SAM 3 Image',
    category: 'SAM 3',
    version: '1.0.0',
    type: 'server',
    description: 'Segment an image using SAM 3 based on a text prompt',
    inputs: [
        {
            name: 'prompt',
            type: 'string',
            description: 'Text prompt for segmentation'
        },
        {
            name: 'image',
            type: 'asset:image',
            description: 'The image to segment'
        }
    ],
    outputs: [
        {
            name: 'image',
            type: 'asset:image',
            description: 'The segmented image (or aggregated mask if enabled)'
        },
        {
            name: 'masks',
            type: 'asset:image',
            description: 'All generated segmentation masks'
        }
    ],
    parameters: [
        {
            name: 'apply_mask',
            type: 'boolean',
            value: true,
            default: true,
            label: 'Apply Mask',
            description: 'Apply the mask on the image'
        },
        {
            name: 'return_multiple_masks',
            type: 'boolean',
            value: false,
            default: false,
            label: 'Return Multiple Masks',
            description: 'Upload and return multiple generated masks'
        },
        {
            name: 'aggregate_masks',
            type: 'boolean',
            value: false,
            default: false,
            label: 'Aggregate Masks',
            description: 'Merge all masks into one and return as the main image',
        },
        {
            name: 'max_masks',
            type: 'number',
            value: 3,
            default: 3,
            min: 1,
            max: 32,
            label: 'Max Masks',
            description: 'Maximum number of masks to return'
        }
    ]
};

const sam3ImageNode: NodeInstance = NanoSDK.registerNode(nodeDefinition);

sam3ImageNode.execute = async ({ inputs, parameters, context }) => {
    configureFalClient();

    const prompt = inputs.prompt?.[0] as string;
    const imageAsset = inputs.image?.[0] as string;

    if (!imageAsset) {
        context.sendStatus({ type: 'error', message: 'Image is required' });
        throw new Error('Image is required');
    }

    const applyMask = Boolean(getParameterValue(parameters, 'apply_mask', true));
    const returnMultipleMasks = Boolean(getParameterValue(parameters, 'return_multiple_masks', false));
    const aggregateMasks = Boolean(getParameterValue(parameters, 'aggregate_masks', false));
    const maxMasks = Number(getParameterValue(parameters, 'max_masks', 3));

    context.sendStatus({ type: 'running', message: 'Preparing image...' });

    try {
        const imageBuffer = await resolveAsset(imageAsset, { asBuffer: true }) as Buffer;
        const blob = new Blob([new Uint8Array(imageBuffer)], { type: 'image/png' });
        const imageUrl = await fal.storage.upload(blob);

        const payload = {
            image_url: imageUrl,
            prompt: prompt || 'wheel',
            apply_mask: applyMask,
            return_multiple_masks: returnMultipleMasks || aggregateMasks,
            max_masks: maxMasks,
            output_format: 'png'
        };

        const strategy = createProgressStrategy({
            expectedMs: 10000,
            inQueueMessage: 'Waiting in queue...',
            finalizingMessage: 'Finalizing segmentation...',
            defaultInProgressMessage: (n) => `Processing step ${n}...`
        });

        let stepCount = 0;

        const result = await fal.subscribe('fal-ai/sam-3/image', {
            input: payload,
            logs: true,
            onQueueUpdate: (status: QueueStatus) => {
                if (status.status === 'IN_QUEUE') {
                    const r = strategy.onQueue();
                    context.sendStatus({ type: 'running', message: r.message, progress: r.progress });
                } else if (status.status === 'IN_PROGRESS') {
                    stepCount++;
                    const r = strategy.onProgress(status, stepCount);
                    context.sendStatus({ type: 'running', message: r.message, progress: r.progress });
                } else if (status.status === 'COMPLETED') {
                    const r = strategy.onCompleted();
                    context.sendStatus({ type: 'running', message: r.message, progress: r.progress });
                }
            }
        }) as Sam3ImageResponse;

        const imageResult = result.data?.image ?? result.image;
        const masksResult = result.data?.masks ?? result.masks ?? [];

        if (!imageResult?.url) {
            throw new Error('No image returned from Fal AI');
        }

        const uploadImage = async (url: string, contentType: string) => {
            const resp = await fetch(url);
            const data = Buffer.from(await resp.arrayBuffer());
            const fname = generateAssetFilename(url, contentType || 'image/png', 'image');
            return uploadAsset(data, { type: 'image', filename: fname });
        };

        const downloadBuffer = async (url: string) => {
            const resp = await fetch(url);
            return Buffer.from(await resp.arrayBuffer());
        };

        let mainImageUri: string;

        if (aggregateMasks && masksResult.length > 0) {
            context.sendStatus({ type: 'running', message: 'Aggregating masks...' });

            const maskBuffers = await Promise.all(
                masksResult
                    .filter(m => m.url)
                    .map(m => downloadBuffer(m.url!))
            );

            if (maskBuffers.length > 0) {
                let composite = sharp(maskBuffers[0]);

                const composites = maskBuffers.slice(1).map(buffer => ({
                    input: buffer,
                    blend: 'lighten' as const
                }));

                if (composites.length > 0) {
                    composite = composite.composite(composites);
                }

                const aggregatedBuffer = await composite.toBuffer();
                const filename = `aggregated-mask-${Date.now()}.png`;
                const uploadResult = await uploadAsset(aggregatedBuffer, { type: 'image', filename });

                if (!uploadResult?.uri) throw new Error('Failed to upload aggregated mask');
                mainImageUri = uploadResult.uri;
            } else {
                const mainImageUpload = await uploadImage(imageResult.url, imageResult.content_type || 'image/png');
                if (!mainImageUpload?.uri) throw new Error('Failed to upload main image');
                mainImageUri = mainImageUpload.uri;
            }

        } else {
            const mainImageUpload = await uploadImage(imageResult.url, imageResult.content_type || 'image/png');
            if (!mainImageUpload?.uri) throw new Error('Failed to upload main image');
            mainImageUri = mainImageUpload.uri;
        }

        let validMaskUris: string[] = [];
        if (masksResult.length > 0) {
            const maskUploadPromises = masksResult.map(async (mask: any) => {
                if (!mask.url) return null;
                return uploadImage(mask.url, mask.content_type || 'image/png');
            });

            const maskUploads = await Promise.all(maskUploadPromises);
            validMaskUris = maskUploads
                .filter((u): u is { uri: string } & any => u !== null && typeof u.uri === 'string')
                .map(u => u.uri);
        }

        return {
            image: [mainImageUri],
            masks: validMaskUris
        };

    } catch (error: any) {
        context.sendStatus({ type: 'error', message: error.message || 'Failed to process image' });
        throw error;
    }
};

export default sam3ImageNode;
