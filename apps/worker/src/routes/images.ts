import { Hono, type Context } from 'hono';
import type { Env } from '../index.js';
import { resolveAccessiblePharmacyTenant } from '../custom/pharmacy/growth-loop/access.js';

const images = new Hono<Env>();
const PUBLIC_IMAGE_KEY = /^(?:tenants\/[a-zA-Z0-9:_-]+\/uploads\/)?[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:png|jpe?g|gif|webp)$/i;
const INCOMING_IMAGE_KEY = /^tenants\/[^/]+\/accounts\/([^/]+)\/incoming\/[^/]+\.(?:png|jpe?g|gif|webp)$/i;

function tenantPrefix(tenantId: string): string {
  return `tenants/${tenantId.replace(/[^a-zA-Z0-9:-]/g, '_')}/`;
}

async function serveImage(
  bucket: R2Bucket,
  key: string,
  cacheControl: string,
): Promise<Response> {
  const object = await bucket.get(key);
  if (!object) {
    return Response.json({ success: false, error: 'Image not found' }, { status: 404 });
  }
  const headers = new Headers();
  headers.set('Content-Type', object.httpMetadata?.contentType || 'image/png');
  headers.set('Cache-Control', cacheControl);
  headers.set('ETag', object.etag);
  return new Response(object.body, { headers });
}

async function canReadIncomingImage(c: Context<Env>, key: string): Promise<boolean> {
  const accountId = INCOMING_IMAGE_KEY.exec(key)?.[1];
  if (!accountId) return false;
  const tenantId = await resolveAccessiblePharmacyTenant(c.env.DB, c.get('staff'), accountId);
  return tenantId === c.get('tenantId');
}

// POST /api/images — upload image (base64 or binary)
images.post('/api/images', async (c) => {
  try {
    const contentType = c.req.header('Content-Type') || '';

    let data: ArrayBuffer;
    let mimeType: string;

    if (contentType.includes('application/json')) {
      const body = await c.req.json<{
        data: string;
        mimeType?: string;
        filename?: string;
      }>();

      if (!body.data) {
        return c.json({ success: false, error: 'data (base64) is required' }, 400);
      }

      let base64 = body.data;
      if (base64.startsWith('data:')) {
        const match = base64.match(/^data:([^;]+);base64,(.+)$/);
        if (match) {
          mimeType = match[1];
          base64 = match[2];
        }
      }
      mimeType ??= body.mimeType ?? 'image/png';

      const binary = Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0));
      data = binary.buffer;
    } else {
      data = await c.req.arrayBuffer();
      mimeType = contentType.split(';')[0] || 'image/png';
    }

    if (data.byteLength > 10 * 1024 * 1024) {
      return c.json({ success: false, error: 'Image too large (max 10MB)' }, 400);
    }

    const allowedTypes = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
    if (!allowedTypes.includes(mimeType)) {
      return c.json({ success: false, error: `Unsupported image type: ${mimeType}. Allowed: ${allowedTypes.join(', ')}` }, 400);
    }

    const ext = mimeType.split('/')[1] === 'jpeg' ? 'jpg' : mimeType.split('/')[1];
    const id = crypto.randomUUID();
    const key = `${tenantPrefix(c.get('tenantId'))}uploads/${id}.${ext}`;

    await c.env.IMAGES.put(key, data, {
      httpMetadata: { contentType: mimeType },
    });

    const workerUrl = c.env.WORKER_URL || new URL(c.req.url).origin;
    const url = `${workerUrl}/images/${key}`;

    return c.json({
      success: true,
      data: { id, key, url, mimeType, size: data.byteLength },
    }, 201);
  } catch (err) {
    console.error('POST /api/images error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /images/:key — public assets used by LINE message delivery.
images.get('/images/:key{.+}', async (c) => {
  const key = c.req.param('key');
  if (!PUBLIC_IMAGE_KEY.test(key)) {
    return c.json({ success: false, error: 'Image not found' }, 404);
  }
  return serveImage(c.env.IMAGES, key, 'public, max-age=31536000, immutable');
});

// Incoming patient images are private and bound to the authenticated tenant.
images.get('/api/images/:key{.+}', async (c) => {
  const key = c.req.param('key');
  if (!key.startsWith(tenantPrefix(c.get('tenantId'))) || !INCOMING_IMAGE_KEY.test(key) ||
      !await canReadIncomingImage(c, key)) {
    return c.json({ success: false, error: 'Image not found' }, 404);
  }
  return serveImage(c.env.IMAGES, key, 'private, no-store');
});

// DELETE /api/images/:key — delete image
images.delete('/api/images/:key{.+}', async (c) => {
  try {
    const key = c.req.param('key');
    if (!key.startsWith(tenantPrefix(c.get('tenantId')))) {
      return c.json({ success: false, error: 'Image not found' }, 404);
    }
    if (INCOMING_IMAGE_KEY.test(key) && !await canReadIncomingImage(c, key)) {
      return c.json({ success: false, error: 'Image not found' }, 404);
    }
    await c.env.IMAGES.delete(key);
    return c.json({ success: true, data: null });
  } catch (err) {
    console.error('DELETE /api/images/:key error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { images };
