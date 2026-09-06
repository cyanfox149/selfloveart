/**
 * 光影集 Cloudflare Worker
 * -------------------------------------------------------------
 * 路由：
 *   GET  /api/health   健康检查
 *   GET  /api/works    读取 works.json（公开，短缓存）
 *   POST /api/upload   上传作品（需 Authorization: Bearer <ADMIN_TOKEN>）
 *                      multipart/form-data：
 *                        meta  = JSON 字符串
 *                          { type:'image'|'group'|'video',
 *                            title, category, description, mediaInfo?,
 *                            items:[{kind:'image'|'video'}, ...] }
 *                        文件字段名 = "<itemIndex>_<role>"
 *                          图片 role: original | thumb | card | large
 *                          视频 role: video（封面图同样用 original|thumb|card|large）
 *
 * 存储结构（R2 Bucket）：
 *   works.json                                   作品元数据
 *   media/images/<yyyymmdd>-<rand>/item0/thumb.webp
 *   media/videos/<yyyymmdd>-<rand>/item0/video.mp4
 *   ...
 * -------------------------------------------------------------
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...CORS_HEADERS,
      ...(init.headers || {}),
    },
  });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    try {
      if (url.pathname === '/api/health') {
        return json({ ok: true, ts: Date.now() });
      }
      if (url.pathname === '/api/works' && request.method === 'GET') {
        return await this.getWorks(env);
      }
      if (url.pathname === '/api/upload' && request.method === 'POST') {
        return await this.upload(request, env);
      }
      return json({ error: 'not found' }, { status: 404 });
    } catch (err) {
      return json({ error: err && err.message ? err.message : String(err) }, { status: 500 });
    }
  },

  /** 读取作品列表；works.json 不存在时返回空列表 */
  async getWorks(env) {
    const obj = await env.BUCKET.get('works.json');
    const body = obj ? await obj.text() : '{"works":[]}';
    return new Response(body, {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=30',
        ...CORS_HEADERS,
      },
    });
  },

  async readWorksDoc(env) {
    const obj = await env.BUCKET.get('works.json');
    if (!obj) return { works: [] };
    try {
      const doc = JSON.parse(await obj.text());
      if (!Array.isArray(doc.works)) doc.works = [];
      return doc;
    } catch {
      return { works: [] };
    }
  },

  async writeWorksDoc(env, doc) {
    await env.BUCKET.put('works.json', JSON.stringify(doc, null, 2), {
      httpMetadata: {
        contentType: 'application/json; charset=utf-8',
        cacheControl: 'public, max-age=30',
      },
    });
  },

  /** 上传作品：鉴权 → 存文件 → 追加 works.json */
  async upload(request, env) {
    // ---- 鉴权：Bearer Token（wrangler secret put ADMIN_TOKEN）----
    const auth = request.headers.get('Authorization') || '';
    const token = auth.replace(/^Bearer\s+/i, '').trim();
    if (!env.ADMIN_TOKEN || token !== env.ADMIN_TOKEN) {
      return json({ error: 'unauthorized：令牌无效' }, { status: 401 });
    }

    const form = await request.formData();
    let meta;
    try {
      meta = JSON.parse(form.get('meta') || '{}');
    } catch {
      return json({ error: 'meta 不是合法 JSON' }, { status: 400 });
    }
    const type = meta.type;
    if (!['image', 'group', 'video'].includes(type)) {
      return json({ error: 'meta.type 必须是 image / group / video' }, { status: 400 });
    }
    if (!meta.title || !String(meta.title).trim()) {
      return json({ error: '标题不能为空' }, { status: 400 });
    }
    const items = Array.isArray(meta.items) ? meta.items : [];
    if (!items.length) {
      return json({ error: '没有可上传的文件' }, { status: 400 });
    }

    // ---- 存储目录：media/images|videos/<日期>-<随机码>/item<序号>/<角色>.<扩展名> ----
    const now = new Date();
    const ymd = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
    const rand = Math.random().toString(36).slice(2, 8);
    const mediaDir = type === 'video' ? 'videos' : 'images';
    const prefix = `media/${mediaDir}/${ymd}-${rand}/`;

    const putRole = async (itemIdx, role) => {
      const file = form.get(`${itemIdx}_${role}`);
      if (!file || typeof file === 'string') return null;
      const ext = (file.name.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '') || 'bin';
      const key = `${prefix}item${itemIdx}/${role}.${ext}`;
      await env.BUCKET.put(key, file.stream(), {
        httpMetadata: { contentType: file.type || 'application/octet-stream' },
      });
      return key;
    };

    // ---- 按作品类型收集各档位 key ----
    let entry;
    if (type === 'group') {
      const previewImages = [];
      const fullImages = [];
      const originalImages = [];
      for (let i = 0; i < items.length; i++) {
        const thumb = await putRole(i, 'thumb');
        const large = await putRole(i, 'large');
        const original = await putRole(i, 'original');
        await putRole(i, 'card'); // 组图不直接用 card 档，存着备用
        if (!thumb || !large || !original) {
          return json({ error: `第 ${i + 1} 张图片缺少文件（thumb/large/original）` }, { status: 400 });
        }
        previewImages.push(thumb);
        fullImages.push(large);
        originalImages.push(original);
      }
      entry = {
        type: 'group',
        isGroup: true,
        title: String(meta.title).trim(),
        category: meta.category || 'landscape',
        previewImages,
        fullImages,
        originalImages,
        mediaInfo: meta.mediaInfo || `组图作品 · ${items.length}张`,
        description: meta.description || '',
      };
    } else if (type === 'video') {
      const videoSrc = await putRole(0, 'video');
      const thumb = await putRole(0, 'thumb');
      const card = await putRole(0, 'card');
      const large = await putRole(0, 'large');
      const original = await putRole(0, 'original');
      if (!videoSrc) return json({ error: '缺少视频文件' }, { status: 400 });
      if (!thumb || !card || !large || !original) {
        return json({ error: '缺少视频封面图（请选择封面或允许自动截帧）' }, { status: 400 });
      }
      entry = {
        type: 'video',
        title: String(meta.title).trim(),
        category: 'video',
        videoSrc,
        thumb,
        card,
        large,
        original,
        mediaInfo: meta.mediaInfo || '视频作品',
        description: meta.description || '',
      };
    } else {
      const thumb = await putRole(0, 'thumb');
      const card = await putRole(0, 'card');
      const large = await putRole(0, 'large');
      const original = await putRole(0, 'original');
      if (!thumb || !card || !large || !original) {
        return json({ error: '图片文件不完整（thumb/card/large/original）' }, { status: 400 });
      }
      entry = {
        type: 'image',
        title: String(meta.title).trim(),
        category: meta.category || 'landscape',
        thumb,
        card,
        large,
        original,
        mediaInfo: meta.mediaInfo || '摄影作品',
        description: meta.description || '',
      };
    }

    // ---- 追加进 works.json（id = 现有最大 id + 1）----
    const doc = await this.readWorksDoc(env);
    entry.id = doc.works.reduce((m, w) => Math.max(m, Number(w.id) || 0), 0) + 1;
    doc.works.push(entry);
    await this.writeWorksDoc(env, doc);

    return json({ ok: true, work: entry });
  },
};
