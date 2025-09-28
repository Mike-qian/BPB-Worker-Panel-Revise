import { Authenticate, generateJWTToken, resetPassword } from "#auth";
import { getClashNormalConfig, getClashWarpConfig } from "#configs/clash";
import { extractWireguardParams, getConfigAddresses, generateRemark } from "#configs/utils";
import { getSingBoxCustomConfig, getSingBoxWarpConfig } from "#configs/sing-box";
import { getXrayCustomConfigs, getXrayWarpConfigs, buildXrayVLOutbound, buildXrayTROutbound } from "#configs/xray";
import { getDataset, updateDataset } from "#kv";
import JSZip from "jszip";
import { fetchWarpConfigs } from "#protocols/warp";
import { globalConfig, httpConfig, wsConfig } from "#common/init";
import { VlOverWSHandler } from "#protocols/websocket/vless";
import { TrOverWSHandler } from "#protocols/websocket/trojan";
export let settings = {}

// 实现旧客户订阅链接功能 - 将 trojan:// 和 vless:// 节点链接合并
async function getLegacySubscriptionConfig(env) {
    const Addresses = await getConfigAddresses(settings.cleanIPs, settings.VLTRenableIPv6, settings.customCdnAddrs, false);
    const totalPorts = settings.ports;
    
    let protocols = [];
    if (settings.VLConfigs) protocols.push(atob('VkxFU1M='));
    if (settings.TRConfigs) protocols.push(atob('VHJvamFu'));
    
    let nodeLinks = [];
    
    for (const protocol of protocols) {
        let protocolIndex = 1;
        for (const port of totalPorts) {
            for (const addr of Addresses) {
                const isCustomAddr = settings.customCdnAddrs.includes(addr);
                const configType = isCustomAddr ? 'C' : '';
                const sni = isCustomAddr ? settings.customCdnSni : randomUpperCase(httpConfig.hostName);
                const host = isCustomAddr ? settings.customCdnHost : httpConfig.hostName;
                const remark = generateRemark(protocolIndex, port, addr, settings.cleanIPs, protocol, configType);
                
                let nodeLink = '';
                if (protocol === atob('VkxFU1M=')) {
                    // 生成 vless:// 链接
                    const uuid = globalConfig.userID;
                    const wsPath = generateWsPath('vl');
                    nodeLink = `vless://${uuid}@${addr}:${port}?encryption=none&security=tls&sni=${encodeURIComponent(sni)}&type=ws&host=${encodeURIComponent(host)}&path=${encodeURIComponent(wsPath)}#${encodeURIComponent(remark)}`;
                } else if (protocol === atob('VHJvamFu')) {
                    // 生成 trojan:// 链接
                    const password = globalConfig.TrPass;
                    const wsPath = generateWsPath('tr');
                    nodeLink = `trojan://${password}@${addr}:${port}?security=tls&sni=${encodeURIComponent(sni)}&type=ws&host=${encodeURIComponent(host)}&path=${encodeURIComponent(wsPath)}#${encodeURIComponent(remark)}`;
                }
                
                if (nodeLink) {
                    nodeLinks.push(nodeLink);
                }
                
                protocolIndex++;
            }
        }
    }
    
    // 将所有节点链接用换行符合并
    const subscriptionContent = nodeLinks.join('\n');
    
    // 对内容进行 base64 编码
    const base64Content = btoa(unescape(encodeURIComponent(subscriptionContent)));
    
    return new Response(base64Content, {
        status: 200,
        headers: {
            'Content-Type': 'text/plain;charset=utf-8',
            'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
            'CDN-Cache-Control': 'no-store'
        }
    });
}

// 辅助函数 - 生成 WebSocket 路径
function generateWsPath(prefix) {
    const randomStr = Math.random().toString(36).substring(2, 8);
    return `/${prefix}-${randomStr}`;
}

// 辅助函数 - 随机大写
function randomUpperCase(str) {
    return str.split('').map(char => 
        Math.random() > 0.5 ? char.toUpperCase() : char
    ).join('');
}

// 其余原有函数保持不变

// 处理WebSocket连接
export async function handleWebsocket(request) {
    const encodedPathConfig = globalConfig.pathName.replace("/", "") || '';

    try {
        const { protocol, mode, panelIPs } = JSON.parse(atob(encodedPathConfig));

        Object.assign(wsConfig, {
            wsProtocol: protocol,
            proxyMode: mode,
            panelIPs: panelIPs
        });

        switch (protocol) {
            case 'vl':
                return await VlOverWSHandler(request);
            case 'tr':
                return await TrOverWSHandler(request);
            default:
                return await fallback(request);
        }

    } catch (error) {
        return new Response('Failed to parse WebSocket path config', { status: 400 });
    }
}

// 处理面板请求
export async function handlePanel(request, env) {
    switch (globalConfig.pathName) {
        case '/panel':
            return await renderPanel(request, env);
        case '/panel/settings':
            return await getSettings(request, env);
        case '/panel/update-settings':
            return await updateSettings(request, env);
        case '/panel/reset-settings':
            return await resetSettings(request, env);
        case '/panel/reset-password':
            return await resetPassword(request, env);
        case '/panel/my-ip':
            return await getMyIP(request);
        case '/panel/update-warp':
            return await updateWarpConfigs(request, env);
        case '/panel/get-warp-configs':
            return await getWarpConfigs(request, env);
        default:
            return await fallback(request);
    }
}

// 处理错误
export async function handleError(error) {
    const html = hexToString(__ERROR_HTML_CONTENT__).replace('__ERROR_MESSAGE__', error.message);

    return new Response(html, {
        status: 200,
        headers: { 'Content-Type': 'text/html' }
    });
}

// 处理登录请求
export async function handleLogin(request, env) {
    if (globalConfig.pathName === '/login') {
        return await renderLogin(request, env);
    }

    if (globalConfig.pathName === '/login/authenticate') {
        return await generateJWTToken(request, env);
    }

    return await fallback(request);
}

// 处理订阅请求
export async function handleSubscriptions(request, env) {
    const dataset = await getDataset(request, env);
    settings = dataset.settings;
    const { client, subPath } = httpConfig;
    const path = decodeURIComponent(globalConfig.pathName);

    switch (path) {
        case `/sub/normal/${subPath}`:
            switch (client) {
                case 'sing-box':
                    return await getSingBoxCustomConfig(env, false);
                case 'clash':
                    return await getClashNormalConfig(env);
                case 'xray':
                    return await getXrayCustomConfigs(env, false);
                default:
                    break;
            }

        case `/sub/fragment/${subPath}`:
            switch (client) {
                case 'sing-box':
                    return await getSingBoxCustomConfig(env, true);
                case 'xray':
                    return await getXrayCustomConfigs(env, true);
                default:
                    break;
            }

        case `/sub/warp/${subPath}`:
            switch (client) {
                case 'clash':
                    return await getClashWarpConfig(request, env, false);
                case 'sing-box':
                    return await getSingBoxWarpConfig(request, env);
                case 'xray':
                    return await getXrayWarpConfigs(request, env, false);
                default:
                    break;
            }

        case `/sub/warp-pro/${subPath}`:
            switch (client) {
                case 'clash':
                    return await getClashWarpConfig(request, env, true);
                case 'xray-knocker':
                case 'xray':
                    return await getXrayWarpConfigs(request, env, true);
                default:
                    break;
            }

        // 添加对旧客户订阅链接的支持
        case `/sub/legacy/${subPath}`:
            return await getLegacySubscriptionConfig(env);

        default:
            return await fallback(request);
    }
}

async function updateSettings(request, env) {
    if (request.method === 'POST') {
        const auth = await Authenticate(request, env);

        if (!auth) {
            return await respond(false, 401, 'Unauthorized or expired session.');
        }

        const proxySettings = await updateDataset(request, env);
        return await respond(true, 200, null, proxySettings);
    }

    return await respond(false, 405, 'Method not allowed.');
}

async function resetSettings(request, env) {
    if (request.method === 'POST') {
        const auth = await Authenticate(request, env);

        if (!auth) {
            return await respond(false, 401, 'Unauthorized or expired session.');
        }

        const proxySettings = await updateDataset(request, env);
        return await respond(true, 200, null, proxySettings);
    }

    return await respond(false, 405, 'Method not allowed!');
}

async function getSettings(request, env) {
    const isPassSet = await env.kv.get('pwd') ? true : false;
    const auth = await Authenticate(request, env);

    if (!auth) {
        return await respond(false, 401, 'Unauthorized or expired session.', { isPassSet });
    }

    const dataset = await getDataset(request, env);
    const data = {
        proxySettings: dataset.settings,
        isPassSet,
        subPath: httpConfig.subPath
    };

    return await respond(true, 200, null, data);
}

export async function fallback(request) {
    const { url, method, headers, body } = request;
    const newURL = new URL(url);
    newURL.hostname = globalConfig.fallbackDomain;
    newURL.protocol = 'https:';
    const newRequest = new Request(newURL.toString(), {
        method,
        headers,
        body,
        redirect: 'manual'
    });

    return await fetch(newRequest);
}

async function getMyIP(request) {
    const ip = await request.text();

    try {
        const response = await fetch(`http://ip-api.com/json/${ip}?nocache=${Date.now()}`);
        const geoLocation = await response.json();

        return await respond(true, 200, null, geoLocation);
    } catch (error) {
        console.error('Error fetching IP address:', error);
        return await respond(false, 500, `Error fetching IP address: ${error}`)
    }
}

async function getWarpConfigs(request, env) {
    const isPro = httpConfig.client === 'amnezia';
    const auth = await Authenticate(request, env);

    if (!auth) {
        return new Response('Unauthorized or expired session.', { status: 401 });
    }

    const { warpConfigs, settings } = await getDataset(request, env);
    const warpConfig = extractWireguardParams(warpConfigs, false);
    const { warpIPv6, publicKey, privateKey } = warpConfig;
    const { warpEndpoints, amneziaNoiseCount, amneziaNoiseSizeMin, amneziaNoiseSizeMax } = settings;
    const zip = new JSZip();
    const trimLines = (string) => string.split("\n").map(line => line.trim()).join("\n");
    const amneziaNoise = isPro
        ?
        `Jc = ${amneziaNoiseCount}
        Jmin = ${amneziaNoiseSizeMin}
        Jmax = ${amneziaNoiseSizeMax}
        S1 = 0
        S2 = 0
        H1 = 0
        H2 = 0
        H3 = 0
        H4 = 0`
        : '';

    try {
        warpEndpoints.forEach((endpoint, index) => {
            zip.file(`${atob('QlBC')}-Warp-${index + 1}.conf`, trimLines(
                `[Interface]
                PrivateKey = ${privateKey}
                Address = 172.16.0.2/32, ${warpIPv6}
                DNS = 1.1.1.1, 1.0.0.1
                MTU = 1280
                ${amneziaNoise}
                [Peer]
                PublicKey = ${publicKey}
                AllowedIPs = 0.0.0.0/0, ::/0
                Endpoint = ${endpoint}
                PersistentKeepalive = 25`
            ));
        });

        const zipBlob = await zip.generateAsync({ type: "blob" });
        const arrayBuffer = await zipBlob.arrayBuffer();

        return new Response(arrayBuffer, {
            headers: {
                "Content-Type": "application/zip",
                "Content-Disposition": `attachment; filename="${atob('QlBC')}-Warp-${isPro ? "Pro-" : ""}configs.zip"`,
            },
        });
    } catch (error) {
        return new Response(`Error generating ZIP file: ${error}`, { status: 500 });
    }
}

export async function serveIcon() {
    const faviconBase64 = __ICON__;
    const body = Uint8Array.from(atob(faviconBase64), c => c.charCodeAt(0));

    return new Response(body, {
        headers: {
            'Content-Type': 'image/x-icon',
            'Cache-Control': 'public, max-age=86400',
        }
    });
}

async function renderPanel(request, env) {
    const pwd = await env.kv.get('pwd');
    
    if (pwd) {
        const auth = await Authenticate(request, env);
        
        if (!auth) {
            return Response.redirect(`${httpConfig.urlOrigin}/login`, 302);
        }
    }

    const html = hexToString(__PANEL_HTML_CONTENT__);
    
    return new Response(html, {
        headers: { 'Content-Type': 'text/html' }
    });
}

async function renderLogin(request, env) {
    const auth = await Authenticate(request, env);
    if (auth) {
        return Response.redirect(`${httpConfig.urlOrigin}/panel`, 302);
    }

    const html = hexToString(__LOGIN_HTML_CONTENT__);
    
    return new Response(html, {
        headers: { 'Content-Type': 'text/html' }
    });
}

export async function renderSecrets() {
    const html = hexToString(__SECRETS_HTML_CONTENT__);
    
    return new Response(html, {
        headers: { 'Content-Type': 'text/html' },
    });
}

async function updateWarpConfigs(request, env) {
    if (request.method === 'POST') {
        const auth = await Authenticate(request, env);
        
        if (!auth) {
            return await respond(false, 401, 'Unauthorized.');
        }

        try {
            await fetchWarpConfigs(env);
            return await respond(true, 200, 'Warp configs updated successfully!');
        } catch (error) {
            console.log(error);
            return await respond(false, 500, `An error occurred while updating Warp configs: ${error}`);
        }
    }

    return await respond(false, 405, 'Method not allowd.');
}

export async function respond(success, status, message, body, customHeaders) {
    return new Response(JSON.stringify({
        success,
        status,
        message: message || '',
        body: body || ''
    }), {
        headers: customHeaders || {
            'Content-Type': message ? 'text/plain' : 'application/json'
        }
    });
}

function hexToString(hex) {
    const bytes = new Uint8Array(hex.match(/.{1,2}/g).map(b => parseInt(b, 16)));
    const decoder = new TextDecoder();
    
    return decoder.decode(bytes);
}

export function isValidUUID(uuid) {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[4][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    return uuidRegex.test(uuid);
}