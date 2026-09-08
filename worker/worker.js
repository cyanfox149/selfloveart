/**
 * 光影集 Cloudflare Worker
 * -------------------------------------------------------------
 * 路由：
 *   GET    /api/health                       健康检查
 *   GET    /api/works                        读取 works.json（公开，短缓存）
 *   POST   /api/upload                       上传作品（Bearer <ADMIN_TOKEN>）
 *   DELETE /api/works/:id                    删除作品（含关联 R2 媒体，best-effort）
 *   PUT    /api/works/:id                    更新作品元数据（title/description/category/mediaInfo）
 *   POST   /api/works/:id/images             向组图追加图片（仅 type:'group'）
 *   DELETE /api/works/:id/images/:index      删除组图中第 index 张图片
 *   PUT    /api/works/:id/images/:index      替换图片（单图或组图均可）
 *
 * 除 GET /api/health 与 GET /api/works 外，其余均需 Authorization: Bearer <ADMIN_TOKEN>
 *
 * 上传(POST /api/upload) multipart/form-data：
 *   meta  = JSON 字符串
 *     { type:'image'|'group'|'video',
 *       title, category, description, mediaInfo?,
 *       items:[{kind:'image'|'video'}, ...] }
 *   文件字段名 = "<itemIndex>_<role>"
 *     图片 role: original | thumb | card | large
 *     视频 role: video（封面图同样用 original|thumb|card|large）
 *
 * 追加图片(POST /api/works/:id/images) multipart/form-data：
 *   meta = JSON 字符串 { items: <新图片数量> }
 *   文件字段 = "<idx>_thumb" | "<idx>_card" | "<idx>_large" | "<idx>_original"
 *
 * 替换图片(PUT /api/works/:id/images/:index) multipart/form-data：
 *   文件字段 = "thumb" | "card" | "large" | "original"
 *
 * 更新元数据(PUT /api/works/:id) JSON body：
 *   任意组合 { title?, description?, category?, mediaInfo? }
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
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
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

      // GET /m/<R2 对象 key>：同域媒体代理，后台缩略图/预览走此路由，
      // 避免依赖独立媒体域名（r2.dev / 自定义域名）可达性，API 能通图片就能显示
      if (request.method === 'GET' && url.pathname.startsWith('/m/')) {
        return await this.serveMedia(env, url.pathname.slice(3));
      }

      // ---- 作品管理路由：/api/works/:id[/images[/:index]] ----
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts[0] === 'api' && parts[1] === 'works' && parts[2]) {
        const id = Number(parts[2]);
        if (!parts[3]) {
          if (request.method === 'DELETE') return await this.deleteWork(request, env, id);
          if (request.method === 'PUT') return await this.updateWork(request, env, id);
        } else if (parts[3] === 'images') {
          if (!parts[4] && request.method === 'POST') {
            return await this.addGroupImages(request, env, id);
          }
          if (parts[4]) {
            const index = Number(parts[4]);
            if (request.method === 'DELETE') return await this.removeGroupImage(request, env, id, index);
            if (request.method === 'PUT') return await this.replaceImage(request, env, id, index);
          }
        }
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

  /** 同域媒体代理：GET /m/<key> → 从 R2 读取并流式返回（供后台缩略图使用） */
  async serveMedia(env, key) {
    let decoded;
    try {
      decoded = decodeURIComponent(key);
    } catch {
      decoded = key;
    }
    const obj = await env.BUCKET.get(decoded);
    if (!obj) {
      return new Response('not found: ' + decoded, {
        status: 404,
        headers: { ...CORS_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }
    return new Response(obj.body, {
      headers: {
        'Content-Type': (obj.httpMetadata && obj.httpMetadata.contentType) || 'application/octet-stream',
        'Cache-Control': 'public, max-age=86400',
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

  /** Bearer Token 鉴权，返回错误 Response 或 null */
  checkAuth(request, env) {
    const auth = request.headers.get('Authorization') || '';
    const token = auth.replace(/^Bearer\s+/i, '').trim();
    if (!env.ADMIN_TOKEN || token !== env.ADMIN_TOKEN) {
      return json({ error: 'unauthorized：令牌无效' }, { status: 401 });
    }
    return null;
  },

  /** 生成新的媒体存储目录前缀：media/images|videos/<yyyymmdd>-<rand>/ */
  genMediaPrefix(type = 'image') {
    const now = new Date();
    const ymd = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
    const rand = Math.random().toString(36).slice(2, 8);
    const mediaDir = type === 'video' ? 'videos' : 'images';
    return `media/${mediaDir}/${ymd}-${rand}/`;
  },

  /** 存储单个文件到 R2，返回 key 或 null（字段缺失/非文件时返回 null） */
  async putFile(env, prefix, itemIdx, role, file) {
    if (!file || typeof file === 'string') return null;
    const ext = (file.name.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '') || 'bin';
    const key = `${prefix}item${itemIdx}/${role}.${ext}`;
    await env.BUCKET.put(key, file.stream(), {
      httpMetadata: { contentType: file.type || 'application/octet-stream' },
    });
    return key;
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

  // ===== 作品管理接口（均需 Bearer Token）=====

  /** DELETE /api/works/:id - 删除作品（含关联 R2 媒体，best-effort） */
  async deleteWork(request, env, id) {
    const authErr = this.checkAuth(request, env);
    if (authErr) return authErr;

    const doc = await this.readWorksDoc(env);
    const idx = doc.works.findIndex(w => Number(w.id) === Number(id));
    if (idx === -1) return json({ error: '作品不存在' }, { status: 404 });
    const work = doc.works[idx];

    // 收集关联 R2 key（best-effort 删除，失败不阻断）
    const keys = [];
    if (work.type === 'group') {
      keys.push(...(work.previewImages || []), ...(work.fullImages || []), ...(work.originalImages || []));
    } else if (work.type === 'video') {
      keys.push(work.videoSrc, work.thumb, work.card, work.large, work.original);
    } else {
      keys.push(work.thumb, work.card, work.large, work.original);
    }
    for (const key of keys) {
      if (key) { try { await env.BUCKET.delete(key); } catch {} }
    }

    doc.works.splice(idx, 1);
    await this.writeWorksDoc(env, doc);
    return json({ ok: true, deleted: id });
  },

  /** PUT /api/works/:id - 更新作品元数据（title/description/category/mediaInfo） */
  async updateWork(request, env, id) {
    const authErr = this.checkAuth(request, env);
    if (authErr) return authErr;

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: '请求体不是合法 JSON' }, { status: 400 });
    }

    const doc = await this.readWorksDoc(env);
    const work = doc.works.find(w => Number(w.id) === Number(id));
    if (!work) return json({ error: '作品不存在' }, { status: 404 });

    for (const k of ['title', 'description', 'category', 'mediaInfo']) {
      if (k in body && body[k] != null) work[k] = body[k];
    }

    await this.writeWorksDoc(env, doc);
    return json({ ok: true, work });
  },

  /** POST /api/works/:id/images - 向组图追加图片（仅 type:'group'） */
  async addGroupImages(request, env, id) {
    const authErr = this.checkAuth(request, env);
    if (authErr) return authErr;

    const doc = await this.readWorksDoc(env);
    const work = doc.works.find(w => Number(w.id) === Number(id));
    if (!work) return json({ error: '作品不存在' }, { status: 404 });
    if (work.type !== 'group') return json({ error: '仅组图作品可追加图片' }, { status: 400 });

    const form = await request.formData();
    let meta;
    try {
      meta = JSON.parse(form.get('meta') || '{}');
    } catch {
      return json({ error: 'meta 不是合法 JSON' }, { status: 400 });
    }
    const itemCount = Number(meta.items) || 0;
    if (itemCount <= 0) return json({ error: '没有可添加的图片' }, { status: 400 });

    const prefix = this.genMediaPrefix('image');
    if (!Array.isArray(work.previewImages)) work.previewImages = [];
    if (!Array.isArray(work.fullImages)) work.fullImages = [];
    if (!Array.isArray(work.originalImages)) work.originalImages = [];

    for (let i = 0; i < itemCount; i++) {
      const thumb = await this.putFile(env, prefix, i, 'thumb', form.get(`${i}_thumb`));
      const large = await this.putFile(env, prefix, i, 'large', form.get(`${i}_large`));
      const original = await this.putFile(env, prefix, i, 'original', form.get(`${i}_original`));
      await this.putFile(env, prefix, i, 'card', form.get(`${i}_card`)); // 组图不直接用 card 档，存着备用
      if (!thumb || !large || !original) {
        return json({ error: `第 ${i + 1} 张图片缺少文件（thumb/large/original）` }, { status: 400 });
      }
      work.previewImages.push(thumb);
      work.fullImages.push(large);
      work.originalImages.push(original);
    }

    // 若 mediaInfo 含数字，则同步更新为当前图片数量
    if (work.mediaInfo && /\d+/.test(work.mediaInfo)) {
      work.mediaInfo = work.mediaInfo.replace(/\d+/, work.previewImages.length);
    }

    await this.writeWorksDoc(env, doc);
    return json({ ok: true, work });
  },

  /** DELETE /api/works/:id/images/:index - 删除组图中第 index 张图片 */
  async removeGroupImage(request, env, id, index) {
    const authErr = this.checkAuth(request, env);
    if (authErr) return authErr;

    const doc = await this.readWorksDoc(env);
    const work = doc.works.find(w => Number(w.id) === Number(id));
    if (!work) return json({ error: '作品不存在' }, { status: 404 });
    if (work.type !== 'group') return json({ error: '仅组图作品可删除图片' }, { status: 400 });

    if (!Array.isArray(work.previewImages) || index < 0 || index >= work.previewImages.length) {
      return json({ error: '图片索引无效' }, { status: 400 });
    }

    // best-effort 删除 R2 对象
    for (const key of [work.previewImages[index], work.fullImages[index], work.originalImages[index]]) {
      if (key) { try { await env.BUCKET.delete(key); } catch {} }
    }

    work.previewImages.splice(index, 1);
    work.fullImages.splice(index, 1);
    work.originalImages.splice(index, 1);

    if (work.mediaInfo && /\d+/.test(work.mediaInfo)) {
      work.mediaInfo = work.mediaInfo.replace(/\d+/, work.previewImages.length);
    }

    await this.writeWorksDoc(env, doc);
    return json({ ok: true, work });
  },

  /** PUT /api/works/:id/images/:index - 替换图片（单图或组图均可） */
  async replaceImage(request, env, id, index) {
    const authErr = this.checkAuth(request, env);
    if (authErr) return authErr;

    const doc = await this.readWorksDoc(env);
    const work = doc.works.find(w => Number(w.id) === Number(id));
    if (!work) return json({ error: '作品不存在' }, { status: 404 });

    const form = await request.formData();
    const prefix = this.genMediaPrefix('image');

    if (work.type === 'group') {
      if (!Array.isArray(work.previewImages) || index < 0 || index >= work.previewImages.length) {
        return json({ error: '图片索引无效' }, { status: 400 });
      }
      const thumb = await this.putFile(env, prefix, 0, 'thumb', form.get('thumb'));
      const large = await this.putFile(env, prefix, 0, 'large', form.get('large'));
      const original = await this.putFile(env, prefix, 0, 'original', form.get('original'));
      await this.putFile(env, prefix, 0, 'card', form.get('card'));
      if (!thumb || !large || !original) {
        return json({ error: '缺少文件（thumb/large/original）' }, { status: 400 });
      }
      work.previewImages[index] = thumb;
      work.fullImages[index] = large;
      work.originalImages[index] = original;
    } else if (work.type === 'image') {
      const thumb = await this.putFile(env, prefix, 0, 'thumb', form.get('thumb'));
      const card = await this.putFile(env, prefix, 0, 'card', form.get('card'));
      const large = await this.putFile(env, prefix, 0, 'large', form.get('large'));
      const original = await this.putFile(env, prefix, 0, 'original', form.get('original'));
      if (!thumb || !card || !large || !original) {
        return json({ error: '图片文件不完整（thumb/card/large/original）' }, { status: 400 });
      }
      work.thumb = thumb;
      work.card = card;
      work.large = large;
      work.original = original;
    } else {
      return json({ error: '该类型作品不支持替换图片' }, { status: 400 });
    }

    await this.writeWorksDoc(env, doc);
    return json({ ok: true, work });
  },
};
