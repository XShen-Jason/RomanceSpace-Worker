/**
 * RomanceSpace Main Edge Router v2
 * Architecture: R2 template store + Cache API + KV routing
 * All user data is HTML-escaped before injection (XSS safe).
 */

// ── Utilities ─────────────────────────────────────────────────────────────────

/**
 * Escape a value for safe HTML insertion.
 * Prevents XSS when injecting user-supplied data into HTML templates.
 */
function escapeHtml(str) {
  if (typeof str !== 'string') str = String(str ?? '');
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Replace {{key}} placeholders in an HTML string with user data.
 * - Strings: directly escaped.
 * - Arrays: each element is escaped, then joined (configurable via schema).
 * - Missing keys: fall back to schema default, or empty string.
 */
function injectData(html, data, schema) {
  return html.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    const raw = data[key];
    const field = schema?.fields?.find(f => f.key === key);

    const resolve = (val) => {
      if (Array.isArray(val)) {
        const join = field?.join ?? '<br>';
        const wrapStart = field?.wrapStart ?? '';
        const wrapEnd = field?.wrapEnd ?? '';
        return wrapStart + val.map(escapeHtml).join(join) + wrapEnd;
      }
      return escapeHtml(String(val ?? ''));
    };

    if (raw === undefined || raw === null) {
      if (!field) return ''; // unknown key → render nothing
      return resolve(field.default ?? '');
    }
    return resolve(raw);
  });
}

/** Map file extensions to MIME types. */
function getMime(filename) {
  const ext = (filename.split('.').pop() ?? '').toLowerCase();
  return ({
    html: 'text/html;charset=UTF-8',
    css: 'text/css',
    js: 'application/javascript',
    json: 'application/json',
    png: 'image/png',
    jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif',
    svg: 'image/svg+xml',
    webp: 'image/webp',
    woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf',
    mp3: 'audio/mpeg', ogg: 'audio/ogg',
  })[ext] ?? 'application/octet-stream';
}

/** Generate a timestamp-based version string, e.g. v20260309152301. */
function makeVersion() {
  return 'v' + new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
}

// ── KV helpers ────────────────────────────────────────────────────────────────

/** Append a subdomain to the reverse index for a given template type. */
async function addToUserIndex(env, type, subdomain) {
  const key = `__users__${type}`;
  const raw = await env.ROMANCESPACE_KV.get(key);
  const list = raw ? JSON.parse(raw) : [];
  if (!list.includes(subdomain)) {
    list.push(subdomain);
    await env.ROMANCESPACE_KV.put(key, JSON.stringify(list));
  }
}

// ── Rendering ─────────────────────────────────────────────────────────────────

/**
 * Fetch the template HTML from R2, inject user data, write result back to
 * R2 as a pre-rendered page, and return the HTML string.
 */
async function prerenderUserPage(env, subdomain, type, data, version) {
  const [htmlObj, schemaObj] = await Promise.all([
    env.ROMANCESPACE_R2.get(`templates/${type}/${version}/index.html`),
    env.ROMANCESPACE_R2.get(`templates/${type}/${version}/schema.json`),
  ]);
  if (!htmlObj) throw new Error(`Template HTML not found in R2 for type='${type}' version='${version}'`);

  const html = await htmlObj.text();
  const schema = schemaObj ? JSON.parse(await schemaObj.text()) : null;
  const rendered = injectData(html, data, schema);

  await env.ROMANCESPACE_R2.put(`pages/${subdomain}.html`, rendered, {
    httpMetadata: { contentType: 'text/html;charset=UTF-8' },
  });
  return rendered;
}

// ── Admin auth ────────────────────────────────────────────────────────────────

function isAdmin(request, env) {
  const key = request.headers.get('X-Admin-Key');
  return key && key === env.ADMIN_KEY;
}

function unauthorized() {
  return new Response(JSON.stringify({ error: 'Unauthorized' }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ── Main handler ──────────────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const host = url.hostname;
    const path = url.pathname;
    const method = request.method;

    // ── 0. Pass-through: Documentation site ───────────────────────
    if (host === 'document.885201314.xyz') {
      const fwd = new URL(request.url);
      fwd.hostname = 'document-9pv.pages.dev';
      return fetch(fwd.toString(), request);
    }

    // ── MAIN DOMAIN ────────────────────────────────────────────────
    const isMainDomain =
      host === 'romancespace.885201314.xyz' || host.includes('workers.dev');

    if (isMainDomain) {

      // ── POST /admin/upload-template ──────────────────────────────
      if (method === 'POST' && path === '/admin/upload-template') {
        if (!isAdmin(request, env)) return unauthorized();

        const ct = request.headers.get('Content-Type') ?? '';
        if (!ct.includes('multipart/form-data')) {
          return new Response(JSON.stringify({ error: 'Expected multipart/form-data' }), {
            status: 400, headers: { 'Content-Type': 'application/json' },
          });
        }

        const formData = await request.formData();
        const templateName = (formData.get('templateName') ?? '').trim();

        if (!templateName || !/^[a-z0-9_]+$/.test(templateName)) {
          return new Response(JSON.stringify({
            error: 'templateName must contain only lowercase letters, numbers, or underscores',
          }), { status: 400, headers: { 'Content-Type': 'application/json' } });
        }

        const version = makeVersion();
        const uploadedFiles = [];

        // Write every file field to R2 under the versioned template path
        for (const [fieldName, file] of formData.entries()) {
          if (fieldName === 'templateName' || typeof file === 'string') continue;
          const r2Key = `templates/${templateName}/${version}/${fieldName}`;
          await env.ROMANCESPACE_R2.put(r2Key, await file.arrayBuffer(), {
            httpMetadata: { contentType: getMime(fieldName) },
          });
          uploadedFiles.push(fieldName);
        }

        if (!uploadedFiles.includes('index.html')) {
          return new Response(JSON.stringify({ error: 'index.html is required' }), {
            status: 400, headers: { 'Content-Type': 'application/json' },
          });
        }

        // Parse schema to determine fields and static flag
        let fields = [];
        let isStatic = true;
        const schemaObj = await env.ROMANCESPACE_R2.get(
          `templates/${templateName}/${version}/schema.json`
        );
        if (schemaObj) {
          const schema = JSON.parse(await schemaObj.text());
          fields = (schema.fields ?? []).map(f => f.key ?? f);
          isStatic = schema.static === true || fields.length === 0;
        }

        // Register / update template metadata in KV
        await env.ROMANCESPACE_KV.put(`__tmpl__${templateName}`, JSON.stringify({
          name: templateName, version, fields, static: isStatic,
          updatedAt: new Date().toISOString(),
        }));

        // If this is an update, re-render all existing user pages in the background
        const userIndexRaw = await env.ROMANCESPACE_KV.get(`__users__${templateName}`);
        const reRenderCount = userIndexRaw ? JSON.parse(userIndexRaw).length : 0;

        if (userIndexRaw) {
          ctx.waitUntil((async () => {
            const users = JSON.parse(userIndexRaw);
            for (const subdomain of users) {
              try {
                const cfgRaw = await env.ROMANCESPACE_KV.get(subdomain);
                if (!cfgRaw) continue;
                const { data = {} } = JSON.parse(cfgRaw);
                await prerenderUserPage(env, subdomain, templateName, data, version);
                // Bust edge cache for this user's page
                await caches.default.delete(
                  new Request(`https://cache.rs.internal/${subdomain}`)
                );
              } catch (e) {
                console.error(`Re-render failed for ${subdomain}:`, e.message);
              }
            }
          })());
        }

        return new Response(JSON.stringify({
          success: true, templateName, version, fields,
          static: isStatic, filesUploaded: uploadedFiles,
          previewUrl: `https://romancespace.885201314.xyz/preview/${templateName}`,
          reRenderingUsers: reRenderCount,
        }), { headers: { 'Content-Type': 'application/json' } });
      }

      // ── POST /admin/render-page ──────────────────────────────────
      if (method === 'POST' && path === '/admin/render-page') {
        if (!isAdmin(request, env)) return unauthorized();

        const body = await request.json();
        const { subdomain, type, data = {} } = body;

        if (!subdomain || !type) {
          return new Response(JSON.stringify({ error: 'subdomain and type are required' }), {
            status: 400, headers: { 'Content-Type': 'application/json' },
          });
        }

        const tmplRaw = await env.ROMANCESPACE_KV.get(`__tmpl__${type}`);
        if (!tmplRaw) {
          return new Response(JSON.stringify({ error: `Template '${type}' not found` }), {
            status: 404, headers: { 'Content-Type': 'application/json' },
          });
        }
        const tmplMeta = JSON.parse(tmplRaw);

        // Persist user config
        await env.ROMANCESPACE_KV.put(subdomain, JSON.stringify({ type, data }));
        await addToUserIndex(env, type, subdomain);

        if (!tmplMeta.static) {
          // Dynamic: pre-render and cache-bust
          await prerenderUserPage(env, subdomain, type, data, tmplMeta.version);
          await caches.default.delete(new Request(`https://cache.rs.internal/${subdomain}`));
        }

        return new Response(JSON.stringify({
          success: true, subdomain, type,
          static: tmplMeta.static,
          url: `https://${subdomain}.885201314.xyz/`,
        }), { headers: { 'Content-Type': 'application/json' } });
      }

      // ── POST /admin/cleanup-template ─────────────────────────────
      if (method === 'POST' && path === '/admin/cleanup-template') {
        if (!isAdmin(request, env)) return unauthorized();

        const { type, keepVersion } = await request.json();
        if (!type || !keepVersion) {
          return new Response(JSON.stringify({ error: 'type and keepVersion are required' }), {
            status: 400, headers: { 'Content-Type': 'application/json' },
          });
        }

        const listed = await env.ROMANCESPACE_R2.list({ prefix: `templates/${type}/` });
        let deleted = 0;
        for (const obj of listed.objects) {
          if (!obj.key.includes(`/${keepVersion}/`)) {
            await env.ROMANCESPACE_R2.delete(obj.key);
            deleted++;
          }
        }
        return new Response(JSON.stringify({ success: true, deletedFiles: deleted }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // ── GET /preview/{type} ──────────────────────────────────────
      if (method === 'GET' && path.startsWith('/preview/')) {
        const type = path.split('/')[2];
        const tmplRaw = await env.ROMANCESPACE_KV.get(`__tmpl__${type}`);
        if (!tmplRaw) return new Response('Template not found', { status: 404 });

        const { version } = JSON.parse(tmplRaw);
        const [htmlObj, schemaObj] = await Promise.all([
          env.ROMANCESPACE_R2.get(`templates/${type}/${version}/index.html`),
          env.ROMANCESPACE_R2.get(`templates/${type}/${version}/schema.json`),
        ]);
        if (!htmlObj) return new Response('Template HTML missing in R2', { status: 404 });

        const html = await htmlObj.text();
        const schema = schemaObj ? JSON.parse(await schemaObj.text()) : null;

        // Build preview defaults from schema
        const defaults = {};
        (schema?.fields ?? []).forEach(f => {
          if (f.default !== undefined) defaults[f.key] = f.default;
        });

        return new Response(injectData(html, defaults, schema), {
          headers: { 'Content-Type': 'text/html;charset=UTF-8' },
        });
      }

      // ── GET /assets/{type}/{...filepath} ─────────────────────────
      if (method === 'GET' && path.startsWith('/assets/')) {
        const parts = path.split('/'); // ['', 'assets', type, ...rest]
        const type = parts[2];
        const filePath = parts.slice(3).join('/');

        const tmplRaw = await env.ROMANCESPACE_KV.get(`__tmpl__${type}`);
        if (!tmplRaw) return new Response('Not found', { status: 404 });
        const { version } = JSON.parse(tmplRaw);

        const obj = await env.ROMANCESPACE_R2.get(`templates/${type}/${version}/${filePath}`);
        if (!obj) return new Response('Asset not found', { status: 404 });

        return new Response(obj.body, {
          headers: {
            'Content-Type': getMime(filePath),
            'Cache-Control': 'public, max-age=604800', // assets cached 7 days
          },
        });
      }

      // ── GET / — Dynamic catalog ──────────────────────────────────
      const tmplList = await env.ROMANCESPACE_KV.list({ prefix: '__tmpl__' });
      const templateMetas = await Promise.all(
        tmplList.keys.map(async k => {
          const r = await env.ROMANCESPACE_KV.get(k.name);
          return r ? JSON.parse(r) : null;
        })
      );
      const templates = templateMetas.filter(Boolean);

      const cards = templates.map(t => `
        <a href="/preview/${t.name}" style="text-decoration:none;color:inherit;">
          <div class="card">
            <h2>📦 ${escapeHtml(t.name)}</h2>
            <p>${t.static
          ? '静态模板（内容固定）'
          : `可定制字段：${(t.fields ?? []).map(escapeHtml).join(', ') || '无'}`
        }</p>
            <span class="badge">${escapeHtml(t.name)}</span>
            <div style="margin-top:12px;color:#d6336c;font-size:.9em;font-weight:bold;">
              👉 点击预览
            </div>
          </div>
        </a>`).join('');

      return new Response(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>RomanceSpace - 模板库</title>
  <style>
    body{font-family:'Inter',sans-serif;background:#fafafa;margin:0;padding:2rem;
      display:flex;flex-direction:column;align-items:center;min-height:100vh;}
    .container{max-width:900px;width:100%;text-align:center;}
    h1{color:#d6336c;font-size:2.5rem;margin-bottom:.5rem;}
    .sub{color:#666;font-size:1.1rem;margin-bottom:3rem;}
    .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:1.5rem;}
    .card{background:#fff;padding:2rem;border-radius:12px;
      box-shadow:0 4px 15px rgba(0,0,0,.05);transition:transform .2s;text-align:left;}
    .card:hover{transform:translateY(-5px);}
    .card h2{color:#2c3e50;margin-top:0;}
    .card p{font-size:.95rem;color:#7f8c8d;margin-bottom:1rem;}
    .badge{display:inline-block;background:#e0f2fe;color:#0284c7;
      padding:4px 10px;border-radius:20px;font-size:.8rem;font-weight:bold;}
    .empty{color:#aaa;font-size:1.1rem;margin-top:4rem;}
  </style>
</head>
<body>
  <div class="container">
    <h1>💕 RomanceSpace</h1>
    <p class="sub">输入已配置好的专属三级域名以访问具体项目。</p>
    <div class="grid">
      ${cards || '<p class="empty">暂无注册模板，请通过管理接口上传。</p>'}
    </div>
  </div>
</body>
</html>`, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
    }

    // ── USER SUBDOMAIN ─────────────────────────────────────────────
    // Pattern: [projectId].885201314.xyz
    const parts = host.split('.');
    const projectId = parts[0];

    // 1. Check Cache API (fastest, free)
    const cacheKey = new Request(`https://cache.rs.internal/${projectId}`);
    const cached = await caches.default.match(cacheKey);
    if (cached) return cached;

    // 2. Load user config from KV
    const cfgRaw = await env.ROMANCESPACE_KV.get(projectId);
    if (!cfgRaw) {
      return new Response(`
        <h1 style="text-align:center;margin-top:50px;font-family:sans-serif;">404 Not Found</h1>
        <p style="text-align:center;color:#666;font-family:sans-serif;">
          项目 '<strong>${escapeHtml(projectId)}</strong>' 不存在或已过期。<br><br>
          <a href="https://romancespace.885201314.xyz" style="color:#d6336c;">
            返回 RomanceSpace 首页
          </a>
        </p>`, {
        status: 404,
        headers: { 'Content-Type': 'text/html;charset=UTF-8' },
      });
    }

    const { type, data = {} } = JSON.parse(cfgRaw);

    // 3. Look up template metadata
    const tmplRaw = await env.ROMANCESPACE_KV.get(`__tmpl__${type}`);
    if (!tmplRaw) {
      return new Response(`
        <h1 style="text-align:center;margin-top:50px;font-family:sans-serif;">模板升级中</h1>
        <p style="text-align:center;color:#666;font-family:sans-serif;">
          该模板正在升级，请稍后刷新页面。
        </p>`, { status: 503, headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
    }
    const tmplMeta = JSON.parse(tmplRaw);

    let html;

    if (tmplMeta.static) {
      // Static template: serve template HTML directly, shared across all users
      const obj = await env.ROMANCESPACE_R2.get(
        `templates/${type}/${tmplMeta.version}/index.html`
      );
      if (!obj) return new Response('模板文件缺失，请联系管理员。', { status: 503 });
      html = await obj.text();
    } else {
      // Dynamic: serve pre-rendered user page from R2
      const obj = await env.ROMANCESPACE_R2.get(`pages/${projectId}.html`);
      if (obj) {
        html = await obj.text();
      } else {
        // Fallback: render on-the-fly (should not normally happen)
        console.warn(`Pre-render missing for '${projectId}', rendering on-the-fly.`);
        html = await prerenderUserPage(env, projectId, type, data, tmplMeta.version);
      }
    }

    const response = new Response(html, {
      headers: {
        'Content-Type': 'text/html;charset=UTF-8',
        'Cache-Control': 'public, max-age=86400',
      },
    });

    // Store in Cache API for all subsequent requests (no R2 cost)
    ctx.waitUntil(caches.default.put(cacheKey, response.clone()));
    return response;
  },
};
