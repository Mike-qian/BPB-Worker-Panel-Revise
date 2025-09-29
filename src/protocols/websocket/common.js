import { connect } from 'cloudflare:sockets';
import { isIPv4, parseHostPort, resolveDNS } from '#configs/utils';
import { wsConfig } from '#common/init';

// WebSocket连接状态常量
export const WS_READY_STATE_CONNECTING = 0;
export const WS_READY_STATE_OPEN = 1;
export const WS_READY_STATE_CLOSING = 2;
export const WS_READY_STATE_CLOSED = 3;

export async function handleTCPOutBound(
    remoteSocket,
    addressRemote,
    portRemote,
    rawClientData,
    webSocket,
    VLResponseHeader,
    log
) {
    async function connectAndWrite(address, port) {
        // if (/^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?).){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/.test(address)) address = `${atob('d3d3Lg==')}${address}${atob('LnNzbGlwLmlv')}`;
        const tcpSocket = connect({
            hostname: address,
            port: port,
        });

        remoteSocket.value = tcpSocket;
        log(`connected to ${address}:${port}`);
        const writer = tcpSocket.writable.getWriter();
        await writer.write(rawClientData); // first write, nomal is tls client hello
        writer.releaseLock();
        return tcpSocket;
    }

    async function retry() {
        let tcpSocket;
        const { proxyMode, panelIPs } = wsConfig;
        const getRandomValue = (arr) => arr[Math.floor(Math.random() * arr.length)];
        const parseIPs = (value) => value ? value.split(',').map(val => val.trim()).filter(Boolean) : undefined;

        if (proxyMode === 'proxyip') {
            log(`direct connection failed, trying to use Proxy IP for ${addressRemote}`);

            try {
                const proxyIPs = parseIPs(wsConfig.envProxyIPs) ||  wsConfig.defaultProxyIPs;
                const ips = panelIPs.length ? panelIPs : proxyIPs;
                const proxyIP = getRandomValue(ips);
                const { host, port } = parseHostPort(proxyIP, true);
                tcpSocket = await connectAndWrite(host || addressRemote, port || portRemote);
            } catch (error) {
                console.error('Proxy IP connection failed:', error);
                webSocket.close(1011, 'Proxy IP connection failed: ' + error.message);
            }

        } else if (proxyMode === 'prefix') {
            log(`direct connection failed, trying to generate dynamic prefix for ${addressRemote}`);

            try {
                const prefixes = parseIPs(wsConfig.envPrefixes) || wsConfig.defaultPrefixes;
                const ips = panelIPs.length ? panelIPs : prefixes;
                const prefix = getRandomValue(ips);
                const dynamicProxyIP = await getDynamicProxyIP(addressRemote, prefix);
                tcpSocket = await connectAndWrite(dynamicProxyIP, portRemote);
            } catch (error) {
                console.error('Prefix connection failed:', error);
                webSocket.close(1011, 'Prefix connection failed: ' + error.message);
            }
        }

        tcpSocket.closed.catch(error => {
            console.log('retry tcpSocket closed error', error);
        }).finally(() => {
            safeCloseWebSocket(webSocket);
        });

        remoteSocketToWS(tcpSocket, webSocket, VLResponseHeader, null, log);
    }

    try {
        const tcpSocket = await connectAndWrite(addressRemote, portRemote);
        remoteSocketToWS(tcpSocket, webSocket, VLResponseHeader, retry, log);
    } catch (error) {
        console.error('Connection failed:', err);
        webSocket.close(1011, 'Connection failed');
    }
}

async function remoteSocketToWS(remoteSocket, webSocket, VLResponseHeader, retry, log) {
    // remote--> ws
    let VLHeader = VLResponseHeader;
    let hasIncomingData = false; // check if remoteSocket has incoming data
    await remoteSocket.readable
        .pipeTo(
            new WritableStream({
                start() { },
                async write(chunk, controller) {
                    hasIncomingData = true;
                    // remoteChunkCount++;
                    if (webSocket.readyState !== WS_READY_STATE_OPEN) {
                        controller.error("webSocket.readyState is not open, maybe close");
                    }

                    if (VLHeader) {
                        webSocket.send(await new Blob([VLHeader, chunk]).arrayBuffer());
                        VLHeader = null;
                    } else {
                        // seems no need rate limit this, CF seems fix this??..
                        // if (remoteChunkCount > 20000) {
                        // 	// cf one package is 4096 byte(4kb),  4096 * 20000 = 80M
                        // 	await delay(1);
                        // }
                        webSocket.send(chunk);
                    }
                },
                close() {
                    log(`remoteConnection!.readable is close with hasIncomingData is ${hasIncomingData}`);
                    // safeCloseWebSocket(webSocket); // no need server close websocket frist for some case will casue HTTP ERR_CONTENT_LENGTH_MISMATCH issue, client will send close event anyway.
                },
                abort(reason) {
                    console.error(`remoteConnection!.readable abort`, reason);
                },
            })
        )
        .catch((error) => {
            console.error(`VLRemoteSocketToWS has exception `, error.stack || error);
            safeCloseWebSocket(webSocket);
        });

    // seems is cf connect socket have error,
    // 1. Socket.closed will have error
    // 2. Socket.readable will be close without any data coming
    if (hasIncomingData === false && retry) {
        log(`retry`);
        retry();
    }
}

export function makeReadableWebSocketStream(webSocketServer, earlyDataHeader, log) {
    let readableStreamCancel = false;
    let isPulling = false;
    let highWaterMark = 16; // 高水位线，控制背压
    let buffer = [];
    
    const stream = new ReadableStream({
        start(controller) {
            // 设置流的高水位线
            highWaterMark = controller.desiredSize || 16;
            
            webSocketServer.addEventListener("message", (event) => {
                if (readableStreamCancel) {
                    return;
                }

                const message = event.data;
                
                // 如果当前不在pull状态且缓冲区未满，则尝试立即入队
                if (!isPulling && buffer.length < highWaterMark) {
                    try {
                        controller.enqueue(message);
                    } catch (error) {
                        console.error('Error enqueuing message:', error);
                        // 如果入队失败，将消息添加到缓冲区
                        buffer.push(message);
                    }
                } else {
                    // 否则将消息添加到缓冲区
                    buffer.push(message);
                }
            });

            // 客户端关闭连接处理
            webSocketServer.addEventListener("close", () => {
                if (readableStreamCancel) {
                    return;
                }

                log('WebSocket client closed connection');
                // 先关闭流，再关闭WebSocket
                controller.close();
                safeCloseWebSocket(webSocketServer);
            });
            
            // WebSocket错误处理
            webSocketServer.addEventListener("error", (err) => {
                log("webSocketServer has error: " + err.message);
                if (!readableStreamCancel) {
                    controller.error(err);
                }
            });
            
            // 保留0-RTT支持
            const { earlyData, error } = base64ToArrayBuffer(earlyDataHeader);

            if (error) {
                controller.error(error);
            } else if (earlyData) {
                // 对于0-RTT数据，优先处理，确保快速响应
                try {
                    controller.enqueue(earlyData);
                } catch (enqueueError) {
                    console.error('Error enqueuing early data:', enqueueError);
                    // 如果入队失败，将早期数据添加到缓冲区
                    buffer.unshift(earlyData); // 使用unshift确保早期数据优先处理
                }
            }
        },
        pull(controller) {
            isPulling = true;
            
            // 更新高水位线
            highWaterMark = controller.desiredSize || 16;
            
            // 如果缓冲区有数据，尝试入队
            while (buffer.length > 0 && controller.desiredSize > 0) {
                try {
                    const message = buffer.shift();
                    controller.enqueue(message);
                } catch (error) {
                    console.error('Error enqueuing from buffer:', error);
                    break;
                }
            }
            
            isPulling = false;
        },
        cancel(reason) {
            if (readableStreamCancel) {
                return;
            }

            log(`ReadableStream was canceled, due to ${reason}`);
            readableStreamCancel = true;
            buffer = []; // 清空缓冲区
            safeCloseWebSocket(webSocketServer, 1000, `Stream canceled: ${reason}`);
        },
    });

    return stream;
}

function base64ToArrayBuffer(base64Str) {
    if (!base64Str) {
        return { earlyData: null, error: null };
    }

    try {
        // go use modified Base64 for URL rfc4648 which js atob not support
        base64Str = base64Str.replace(/-/g, '+').replace(/_/g, '/');
        const decode = atob(base64Str);
        const arryBuffer = Uint8Array.from(decode, (c) => c.charCodeAt(0));
        return { earlyData: arryBuffer.buffer, error: null };
    } catch (error) {
        return { earlyData: null, error };
    }
}

export function safeCloseWebSocket(socket, code = 1000, reason = '') {
    try {
        if (socket.readyState === WS_READY_STATE_OPEN || socket.readyState === WS_READY_STATE_CLOSING) {
            // WebSocket.close()最多接受123字节的原因描述
            const safeReason = reason.length > 123 ? reason.substring(0, 120) + '...' : reason;
            socket.close(code, safeReason);
        }
    } catch (error) {
        console.error('safeCloseWebSocket error', error);
    }
}

async function getDynamicProxyIP(address, prefix) {
    let finalAddress = address;

    if (!isIPv4(address)) {
        const { ipv4 } = await resolveDNS(address, true);

        if (ipv4.length) {
            finalAddress = ipv4[0];
        } else {
            throw new Error('Unable to find IPv4 in DNS records');
        }
    }

    return convertToNAT64IPv6(finalAddress, prefix);
}

function convertToNAT64IPv6(ipv4Address, prefix) {
    const parts = ipv4Address.split('.');

    if (parts.length !== 4) {
        throw new Error('Invalid IPv4 address');
    }

    const hex = parts.map(part => {
        const num = parseInt(part, 10);

        if (num < 0 || num > 255) {
            throw new Error('Invalid IPv4 address');
        }

        return num.toString(16).padStart(2, '0');
    });

    const match = prefix.match(/^\[([0-9A-Fa-f:]+)\]$/);

    if (match) {
        return `[${match[1]}${hex[0]}${hex[1]}:${hex[2]}${hex[3]}]`;
    }
}

