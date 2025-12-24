import { NanoSDK, NodeDefinition, NodeInstance, resolveAsset } from '@nanograph/sdk';
import { QueueStatus } from '@fal-ai/client';
import { configureFalClient, fal } from '../../utils/fal-client.js';
import { createProgressStrategy } from '../../utils/progress-strategy.js';

interface Sam3EmbedResponse {
    data?: {
        embedding_b64?: string;
    };
    embedding_b64?: string;
}

const nodeDefinition: NodeDefinition = {
    uid: 'fal-ai/sam-3/image/embed',
    name: 'SAM 3 Image Embed',
    category: 'SAM 3',
    version: '1.0.0',
    type: 'server',
    description: 'Generate an embedding for an image using SAM 3',
    inputs: [
        {
            name: 'image',
            type: 'asset:image',
            description: 'The image to embed'
        }
    ],
    outputs: [
        {
            name: 'embedding_b64',
            type: 'string',
            description: 'The image embedding in base64 format'
        }
    ],
    parameters: []
};

const sam3EmbedNode: NodeInstance = NanoSDK.registerNode(nodeDefinition);

sam3EmbedNode.execute = async ({ inputs, context }) => {
    configureFalClient();

    const imageAsset = inputs.image?.[0] as string;

    if (!imageAsset) {
        context.sendStatus({ type: 'error', message: 'Image is required' });
        throw new Error('Image is required');
    }

    context.sendStatus({ type: 'running', message: 'Uploading image...' });

    try {
        const imageBuffer = await resolveAsset(imageAsset, { asBuffer: true }) as Buffer;
        const blob = new Blob([new Uint8Array(imageBuffer)], { type: 'image/png' });
        const imageUrl = await fal.storage.upload(blob);

        const payload = {
            image_url: imageUrl
        };

        const strategy = createProgressStrategy({
            expectedMs: 5000,
            inQueueMessage: 'Waiting in queue...',
            finalizingMessage: 'Generating embedding...',
            defaultInProgressMessage: (n) => `Processing step ${n}...`
        });

        let stepCount = 0;

        const result = await fal.subscribe('fal-ai/sam-3/image/embed', {
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
        }) as Sam3EmbedResponse;

        const embedding = result.data?.embedding_b64 ?? result.embedding_b64;

        if (!embedding) {
            throw new Error('No embedding returned from Fal AI');
        }

        return {
            embedding_b64: [embedding]
        };

    } catch (error: any) {
        context.sendStatus({ type: 'error', message: error.message || 'Failed to generate embedding' });
        throw error;
    }
};

export default sam3EmbedNode;
