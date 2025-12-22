import { NanoSDK, NodeDefinition, NodeInstance, resolveAsset, uploadAsset } from '@nanograph/sdk'
import { QueueStatus } from '@fal-ai/client'
import { configureFalClient, fal } from '../../utils/fal-client.js'
import { getParameterValue } from '../../utils/parameter-utils.js'
import { createProgressStrategy } from '../../utils/progress-strategy.js'
import { uploadBufferToFal } from '../../utils/fal-storage.js'

interface Hunyuan3DV21Response {
  data: {
    model_glb: {
      url: string
      content_type?: string
      file_name?: string
      file_size?: number
    }
    model_glb_pbr?: {
      url: string
      content_type?: string
      file_name?: string
      file_size?: number
    }
    model_mesh: {
      url: string
      content_type?: string
      file_name?: string
      file_size?: number
    }
    seed: number
  }
  requestId?: string
}

const nodeDef: NodeDefinition = {
  uid: 'hunyuan3d-v21-image-to-3d',
  name: 'Hunyuan3D v2.1 Image to 3D',
  category: 'Hunyuan / Hunyuan 3D',
  version: '1.0.0',
  type: 'server',
  description: 'Generates a 3D model (GLB) from an input image using Fal.ai Hunyuan3D v2.1 with PBR materials support',
  inputs: [
    {
      name: 'image',
      type: 'asset:image',
      description: 'Input image as asset URI'
    }
  ],
  outputs: [
    {
      name: 'model_glb',
      type: 'asset:mesh',
      description: 'Generated 3D model (GLB) uploaded as asset URI'
    },
    {
      name: 'model_glb_pbr',
      type: 'asset:mesh',
      description: 'Generated 3D model with PBR materials (GLB) uploaded as asset URI'
    },
    {
      name: 'seed',
      type: 'number',
      description: 'Seed value used for generation'
    }
  ],
  parameters: [
    {
      name: 'num_inference_steps',
      type: 'number',
      value: 50,
      default: 50,
      label: 'Inference Steps',
      description: 'Number of inference steps to perform',
      min: 1,
      max: 50
    },
    {
      name: 'guidance_scale',
      type: 'number',
      value: 7.5,
      default: 7.5,
      label: 'Guidance Scale',
      description: 'How closely to follow the prompt (higher = more faithful)',
      min: 0,
      max: 20
    },
    {
      name: 'octree_resolution',
      type: 'number',
      value: 256,
      default: 256,
      label: 'Octree Resolution',
      description: 'Octree resolution for the model',
      min: 1,
      max: 1024
    },
    {
      name: 'textured_mesh',
      type: 'boolean',
      value: false,
      default: false,
      label: 'Textured Mesh',
      description: 'Generate textured mesh (costs 3x of white mesh)'
    },
    {
      name: 'seed',
      type: 'number',
      value: -1,
      default: -1,
      label: 'Seed (-1 = random)',
      description: 'Use fixed seed >= 0 for reproducibility'
    }
  ]
}

const hunyuan3DV21Node: NodeInstance = NanoSDK.registerNode(nodeDef)

hunyuan3DV21Node.execute = async ({ inputs, parameters, context }) => {
  // Configure Fal client
  configureFalClient()

  const image = inputs.image?.[0] as string

  if (!image) {
    context.sendStatus({ type: 'error', message: 'Input image is required' })
    throw new Error('Input image is required')
  }

  // Get parameters
  const num_inference_steps = getParameterValue(parameters, 'num_inference_steps', 50)
  const guidance_scale = getParameterValue(parameters, 'guidance_scale', 7.5)
  const octree_resolution = getParameterValue(parameters, 'octree_resolution', 256)
  const textured_mesh = getParameterValue(parameters, 'textured_mesh', false)
  const seed = getParameterValue(parameters, 'seed', -1)

  context.sendStatus({ type: 'running', message: 'Preparing input image...' })

  try {
    // Resolve input image asset and convert to data URL
    const imageBuffer: Buffer = await resolveAsset(image, { asBuffer: true }) as Buffer
    const imageUrl = await uploadBufferToFal(imageBuffer, 'jpeg', { filenamePrefix: 'hunyuan3d-v21-source' })

    let stepCount = 0
    const expectedMs = 90000
    const strategy = createProgressStrategy({
      expectedMs,
      inQueueMessage: 'Waiting in queue...',
      finalizingMessage: 'Finalizing...',
      defaultInProgressMessage: (n) => `Processing step ${n}...`
    })
    const result = await fal.subscribe('fal-ai/hunyuan3d-v21', {
      input: {
        input_image_url: imageUrl,
        num_inference_steps: Number(num_inference_steps),
        guidance_scale: Number(guidance_scale),
        octree_resolution: Number(octree_resolution),
        textured_mesh: Boolean(textured_mesh),
        ...(Number(seed) >= 0 ? { seed: Number(seed) } : {})
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
    }) as Hunyuan3DV21Response

    if (!result.data || !result.data.model_glb || !result.data.model_glb.url) {
      throw new Error('No 3D model was generated')
    }

    // Helper function to upload a file and return asset URI
    const uploadFile = async (fileData: { url: string; file_name?: string; content_type?: string }) => {
      const response = await fetch(fileData.url)
      const arrayBuffer = await response.arrayBuffer()
      const buffer = Buffer.from(arrayBuffer)

      const filename = fileData.file_name || 'model.glb'
      const contentType = fileData.content_type || 'model/gltf-binary'
      const uploadOptions: any = { type: 'mesh', filename, contentType }
      const uploadResult = await uploadAsset(buffer, uploadOptions)

      if (!(uploadResult as any).uri) {
        throw new Error('Failed to upload generated 3D model')
      }

      return (uploadResult as any).uri
    }

    // Upload all generated models
    const [modelGlbUri, modelGlbPbrUri] = await Promise.all([
      uploadFile(result.data.model_glb),
      result.data.model_glb_pbr ? uploadFile(result.data.model_glb_pbr) : null
    ])

    return {
      model_glb: [modelGlbUri],
      model_glb_pbr: modelGlbPbrUri ? [modelGlbPbrUri] : [],
      seed: [result.data.seed]
    }
  } catch (error: any) {
    context.sendStatus({ type: 'error', message: error.message || 'Failed to generate 3D model' })
    throw error
  }
}

export default hunyuan3DV21Node
