import { NanoSDK, NodeDefinition, NodeInstance, resolveAsset, uploadAsset } from '@nanograph/sdk'
import { QueueStatus } from '@fal-ai/client'
import { configureFalClient, fal } from '../../utils/fal-client.js'
import { getParameterValue } from '../../utils/parameter-utils.js'
import { createProgressStrategy } from '../../utils/progress-strategy.js'
import { uploadBufferToFal } from '../../utils/fal-storage.js'

interface Hunyuan3DResponse {
  data: {
    model_mesh: {
      url: string
      content_type?: string
      file_name?: string
      file_size?: number
    }
    seed?: number
  }
  requestId?: string
}

const nodeDef: NodeDefinition = {
  uid: 'hunyuan3d-image-to-3d',
  name: 'Hunyuan3D Image to 3D',
  category: 'Hunyuan / Hunyuan 3D',
  version: '1.0.0',
  type: 'server',
  description: 'Generates a 3D model (GLB) from an input image using Fal.ai Hunyuan3D v2',
  inputs: [
    {
      name: 'image',
      type: 'asset:image',
      description: 'Input image as asset URI'
    }
  ],
  outputs: [
    {
      name: 'model_mesh',
      type: 'asset:mesh',
      description: 'Generated 3D model (GLB) uploaded as asset URI'
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
      max: 200
    },
    {
      name: 'guidance_scale',
      type: 'number',
      value: 7.5,
      default: 7.5,
      label: 'Guidance Scale',
      description: 'How closely to follow the prompt (higher = more faithful)',
      min: 0.1,
      max: 20
    },
    {
      name: 'octree_resolution',
      type: 'select',
      value: '256',
      default: '256',
      label: 'Octree Resolution',
      description: 'Octree resolution for the model',
      options: [
        { label: '128', value: '128' },
        { label: '256', value: '256' },
        { label: '512', value: '512' }
      ]
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

const hunyuan3DNode: NodeInstance = NanoSDK.registerNode(nodeDef)

hunyuan3DNode.execute = async ({ inputs, parameters, context }) => {
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
  const octree_resolution = getParameterValue(parameters, 'octree_resolution', '256')
  const textured_mesh = getParameterValue(parameters, 'textured_mesh', false)
  const seed = getParameterValue(parameters, 'seed', -1)

  context.sendStatus({ type: 'running', message: 'Preparing input image...' })

  try {
    // Resolve input image asset and convert to data URL
    const imageBuffer: Buffer = await resolveAsset(image, { asBuffer: true }) as Buffer
    const imageUrl = await uploadBufferToFal(imageBuffer, 'jpeg', { filenamePrefix: 'hunyuan3d-source' })

    let stepCount = 0
    const expectedMs = 90000
    const strategy = createProgressStrategy({
      expectedMs,
      inQueueMessage: 'Waiting in queue...',
      finalizingMessage: 'Finalizing...',
      defaultInProgressMessage: (n) => `Processing step ${n}...`
    })
    const result = await fal.subscribe('fal-ai/hunyuan3d/v2', {
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
    }) as Hunyuan3DResponse

    if (!result.data || !result.data.model_mesh || !result.data.model_mesh.url) {
      throw new Error('No 3D model was generated')
    }

    // Fetch the GLB and upload as file asset with coherent name and content type
    const modelUrl = result.data.model_mesh.url
    const response = await fetch(modelUrl)
    const arrayBuffer = await response.arrayBuffer()
    const buffer = Buffer.from(arrayBuffer)

    // Determine filename and content type
    const apiFileName = result.data.model_mesh.file_name
    const textured = Boolean(textured_mesh)
    const fallbackName = textured ? 'textured_mesh.glb' : 'white_mesh.glb'
    const ensureGlb = (name: string) => (name?.toLowerCase().endsWith('.glb') ? name : `${name}.glb`)
    const filename = ensureGlb(apiFileName || fallbackName)
    const contentType = result.data.model_mesh.content_type || 'model/gltf-binary'

    const uploadOptions: any = { type: 'mesh', filename, contentType }
    const uploadResult = await uploadAsset(buffer, uploadOptions)

    if (!(uploadResult as any).uri) {
      throw new Error('Failed to upload generated 3D model')
    }

    return {
      model_mesh: [(uploadResult as any).uri]
    }
  } catch (error: any) {
    context.sendStatus({ type: 'error', message: error.message || 'Failed to generate 3D model' })
    throw error
  }
}

export default hunyuan3DNode
