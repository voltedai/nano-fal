import { NanoSDK, NodeDefinition, NodeInstance, resolveAsset } from '@nanograph/sdk';
import { QueueStatus } from '@fal-ai/client';
import { configureFalClient, fal } from '../../utils/fal-client.js';
import { getParameterValue } from '../../utils/parameter-utils.js';
import { createProgressStrategy } from '../../utils/progress-strategy.js';

interface Sam33DResponse {
    data?: {
        model_glb?: { url?: string };
        gaussian_splat?: { url?: string };
        artifacts_zip?: { url?: string };
    };
    model_glb?: { url?: string };
    gaussian_splat?: { url?: string };
    artifacts_zip?: { url?: string };
}

const nodeDefinition: NodeDefinition = {
    uid: 'fal-ai/sam-3/3d-objects',
    name: 'SAM 3 3D Objects',
    category: 'SAM 3',
    version: '1.0.0',
    type: 'server',
    description: 'Reconstruct 3D objects from an image using SAM 3',
    inputs: [
        {
            name: 'prompt',
            type: 'string',
            description: 'Text prompt for auto-segmentation'
        },
        {
            name: 'image',
            type: 'asset:image',
            description: 'The image to reconstruct'
        }
    ],
    outputs: [
        {
            name: 'model_glb',
            type: 'string',
            description: '3D object mesh in GLB format'
        },
        {
            name: 'gaussian_splat',
            type: 'string',
            description: 'Gaussian splat file (.ply)'
        },
        {
            name: 'artifacts_zip',
            type: 'string',
            description: 'Zip bundle containing all artifacts'
        }
    ],
    parameters: [
        {
            name: 'export_textured_glb',
            type: 'boolean',
            value: false,
            default: false,
            label: 'Export Textured GLB',
            description: 'Export GLB with baked texture and UVs instead of vertex colors'
        },
        {
            name: 'seed',
            type: 'number',
            value: null,
            default: null,
            label: 'Seed',
            description: 'Random seed for reproducibility',
            optional: true
        }
    ]
};

const sam33DNode: NodeInstance = NanoSDK.registerNode(nodeDefinition);

sam33DNode.execute = async ({ inputs, parameters, context }) => {
    configureFalClient();

    const prompt = inputs.prompt?.[0] as string;
    const imageAsset = inputs.image?.[0] as string;

    if (!imageAsset) {
        context.sendStatus({ type: 'error', message: 'Image is required' });
        throw new Error('Image is required');
    }

    const exportTexturedGlb = Boolean(getParameterValue(parameters, 'export_textured_glb', false));
    const seedValue = getParameterValue(parameters, 'seed', null);
    const seed = seedValue ? Number(seedValue) : undefined;

    context.sendStatus({ type: 'running', message: 'Uploading image...' });

    try {
        const imageBuffer = await resolveAsset(imageAsset, { asBuffer: true }) as Buffer;
        const blob = new Blob([new Uint8Array(imageBuffer)], { type: 'image/png' });
        const imageUrl = await fal.storage.upload(blob);

        const payload = {
            image_url: imageUrl,
            prompt: prompt || 'car',
            export_textured_glb: exportTexturedGlb,
            seed: seed
        };

        const strategy = createProgressStrategy({
            expectedMs: 60000,
            inQueueMessage: 'Waiting in queue...',
            finalizingMessage: 'Reconstructing 3D objects...',
            defaultInProgressMessage: (n) => `Processing step ${n}...`
        });

        let stepCount = 0;

        const result = await fal.subscribe('fal-ai/sam-3/3d-objects', {
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
        }) as Sam33DResponse;

        const modelGlb = result.data?.model_glb ?? result.model_glb;
        const gaussianSplat = result.data?.gaussian_splat ?? result.gaussian_splat;
        const artifactsZip = result.data?.artifacts_zip ?? result.artifacts_zip;

        if (!modelGlb?.url && !gaussianSplat?.url) {
            throw new Error('No 3D data returned from Fal AI');
        }

        return {
            model_glb: modelGlb?.url ? [modelGlb.url] : [],
            gaussian_splat: gaussianSplat?.url ? [gaussianSplat.url] : [],
            artifacts_zip: artifactsZip?.url ? [artifactsZip.url] : []
        };

    } catch (error: any) {
        context.sendStatus({ type: 'error', message: error.message || 'Failed to generate 3D objects' });
        throw error;
    }
};

export default sam33DNode;
