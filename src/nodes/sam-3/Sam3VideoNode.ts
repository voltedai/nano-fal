import { NanoSDK, NodeDefinition, NodeInstance, resolveAsset, uploadAsset } from '@nanograph/sdk';
import { QueueStatus } from '@fal-ai/client';
import { configureFalClient, fal } from '../../utils/fal-client.js';
import { getParameterValue } from '../../utils/parameter-utils.js';
import { generateAssetFilename } from '../../utils/asset-utils.js';
import { createProgressStrategy } from '../../utils/progress-strategy.js';

interface Sam3VideoResponse {
    data?: {
        video?: {
            url?: string;
            content_type?: string;
            file_size?: number;
        };
        boundingbox_frames_zip?: {
            url?: string;
            file_name?: string;
        };
    };
    video?: {
        url?: string;
        content_type?: string;
        file_size?: number;
    };
    boundingbox_frames_zip?: {
        url?: string;
        file_name?: string;
    };
}

const nodeDefinition: NodeDefinition = {
    uid: 'fal-ai/sam-3/video',
    name: 'SAM 3 Video',
    category: 'SAM 3',
    version: '1.0.0',
    type: 'server',
    description: 'Segment a video using SAM 3 based on a text prompt',
    inputs: [
        {
            name: 'prompt',
            type: 'string',
            description: 'Text prompt for segmentation'
        },
        {
            name: 'video',
            type: 'asset:video',
            description: 'The video to segment'
        }
    ],
    outputs: [
        {
            name: 'video',
            type: 'asset:video',
            description: 'The segmented video'
        },
        {
            name: 'boundingbox_frames_zip',
            type: 'string', // Zip file URL
            description: 'Zip file containing per-frame bounding box overlays'
        }
    ],
    parameters: [
        {
            name: 'detection_threshold',
            type: 'number',
            value: 0.5,
            default: 0.5,
            min: 0.1,
            max: 1.0,
            label: 'Detection Threshold',
            description: 'Detection confidence threshold (0.0-1.0)'
        },
        {
            name: 'apply_mask',
            type: 'boolean',
            value: true,
            default: true,
            label: 'Apply Mask',
            description: 'Apply the mask on the video'
        }
    ]
};

const sam3VideoNode: NodeInstance = NanoSDK.registerNode(nodeDefinition);

sam3VideoNode.execute = async ({ inputs, parameters, context }) => {
    configureFalClient();

    const prompt = inputs.prompt?.[0] as string;
    const videoAsset = inputs.video?.[0] as string;

    if (!videoAsset) {
        context.sendStatus({ type: 'error', message: 'Video is required' });
        throw new Error('Video is required');
    }

    const detectionThreshold = Number(getParameterValue(parameters, 'detection_threshold', 0.5));
    const applyMask = Boolean(getParameterValue(parameters, 'apply_mask', true));

    context.sendStatus({ type: 'running', message: 'Uploading video...' });

    try {
        const videoBuffer = await resolveAsset(videoAsset, { asBuffer: true }) as Buffer;
        const blob = new Blob([new Uint8Array(videoBuffer)], { type: 'video/mp4' });
        const videoUrl = await fal.storage.upload(blob);

        const payload = {
            video_url: videoUrl,
            prompt: prompt || '',
            detection_threshold: detectionThreshold,
            apply_mask: applyMask
        };

        const strategy = createProgressStrategy({
            expectedMs: 30000,
            inQueueMessage: 'Waiting in queue...',
            finalizingMessage: 'Finalizing video segmentation...',
            defaultInProgressMessage: (n) => `Processing step ${n}...`
        });

        let stepCount = 0;

        const result = await fal.subscribe('fal-ai/sam-3/video', {
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
        }) as Sam3VideoResponse;

        const videoResult = result.data?.video ?? result.video;
        const zipResult = result.data?.boundingbox_frames_zip ?? result.boundingbox_frames_zip;

        if (!videoResult?.url) {
            throw new Error('No video returned from Fal AI');
        }

        const videoResponse = await fetch(videoResult.url);
        const videoBufferData = Buffer.from(await videoResponse.arrayBuffer());
        const videoFilename = generateAssetFilename(videoResult.url, videoResult.content_type || 'video/mp4', 'video');
        const uploadVideoResult = await uploadAsset(videoBufferData, { type: 'video', filename: videoFilename });

        return {
            video: [uploadVideoResult.uri],
            boundingbox_frames_zip: zipResult?.url ? [zipResult.url] : []
        };

    } catch (error: any) {
        context.sendStatus({ type: 'error', message: error.message || 'Failed to process video' });
        throw error;
    }
};

export default sam3VideoNode;
