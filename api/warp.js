import nacl from "tweetnacl";
import { Buffer } from "buffer";

const BACKUP_API_PREFIXES = [
  'v0i1909051800', 
  'v0a1909051800',  
  'v0b1909051800',  
  'v0c1909051800',  
  'v0i1604021500',  
  'v0a1604021500',  
];  

class CloudflareWarpClient {
  static BASE_URL = 'https://api.cloudflareclient.com';
  static DEFAULT_HEADERS = {
    'User-Agent': 'okhttp/3.12.1',
    'Content-Type': 'application/json',
  };

  constructor() {
    this.currentPrefixIndex = 0;
    this.baseUrl = `${CloudflareWarpClient.BASE_URL}/${BACKUP_API_PREFIXES[0]}`;
  }

  async registerClient(publicKey) {
    const requestBody = {
      install_id: '',
      tos: new Date().toISOString(),
      key: publicKey,
      fcm_token: '',
      type: 'ios',
      locale: 'en_US',
    };

    for (let i = 0; i < BACKUP_API_PREFIXES.length; i++) {
      try {
        const prefix = BACKUP_API_PREFIXES[i];
        const url = `${CloudflareWarpClient.BASE_URL}/${prefix}/reg`;
        
        const response = await fetch(url, {
          method: 'POST',
          headers: CloudflareWarpClient.DEFAULT_HEADERS,
          body: JSON.stringify(requestBody)
        });

        if (response.status === 429) {
          continue;
        }

        const data = await response.json();

        if (data.success !== false && data.result?.id && data.result?.token) {
          this.baseUrl = `${CloudflareWarpClient.BASE_URL}/${prefix}`;
          return {
            id: data.result.id,
            token: data.result.token,
          };
        }
      } catch (error) {
        continue;
      }
    }

    throw new Error('All API prefixes failed');
  }

  async enableWarp(clientId, token) {
    const headers = {
      ...CloudflareWarpClient.DEFAULT_HEADERS,
      'Authorization': `Bearer ${token}`,
    };

    const response = await fetch(`${this.baseUrl}/reg/${clientId}`, {
      method: 'PATCH',
      headers: headers,
      body: JSON.stringify({ warp_enabled: true })
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();

    if (!data.result?.config?.peers?.[0] || !data.result?.config?.interface) {
      throw new Error('Invalid WARP configuration response structure');
    }

    return data;
  }
}

class CryptoUtils {
  static generateKeyPair() {
    const keyPair = nacl.box.keyPair();

    return {
      privateKey: Buffer.from(keyPair.secretKey).toString('base64'),
      publicKey: Buffer.from(keyPair.publicKey).toString('base64'),
    };
  }

  static stringToBase64(str) {
    return Buffer.from(str).toString('base64');
  }
}

class WarpConfigBuilder {
  static DEVICE_PROFILES = {
    computer: { jc: 4, jmin: 40, jmax: 70 },
  };

  static build(params) {
    const interfaceSection = this.buildInterfaceSection(params);
    const peerSection = this.buildPeerSection(params);
    return `${interfaceSection}\n\n${peerSection}`;
  }

  static buildInterfaceSection(params) {
    const { privateKey, clientIPv4, clientIPv6, deviceType } = params;
    const profile = this.DEVICE_PROFILES[deviceType];

    let lines = [
      '[Interface]',
      `PrivateKey = ${privateKey}`,
      `Address = ${clientIPv4}, ${clientIPv6}`,
      'DNS = 1.1.1.1, 2606:4700:4700::1111, 1.0.0.1, 2606:4700:4700::1001',
      'MTU = 1280',
      `Jc = ${profile.jc}`,
      `Jmin = ${profile.jmin}`,
      `Jmax = ${profile.jmax}`,
      'S1 = 0',
      'S2 = 0',
      'H1 = 1',
      'H2 = 2',
      'H3 = 3',
      'H4 = 4',
    ];

    return lines.join('\n');
  }

  static buildPeerSection(params) {
    const { publicKey, endpoint } = params;

    return [
      '[Peer]',
      `PublicKey = ${publicKey}`,
      'AllowedIPs = 0.0.0.0/0, ::/0',
      `Endpoint = ${endpoint}`,
      'PersistentKeepalive = 25',
    ].join('\n');
  }
}

const ENDPOINT_MAP = {
  'standard': { deviceType: 'computer', endpoint: 'engage.cloudflareclient.com:2408', name: 'Cloudflare WARP' },
  'fr':       { deviceType: 'computer', endpoint: '147.135.212.152:5242', name: 'Roubaix, FR' },
  'pl':       { deviceType: 'computer', endpoint: '51.38.153.32:5242', name: 'Warsaw, PL' },
  'de':       { deviceType: 'computer', endpoint: '51.38.107.252:5242', name: 'Frankfurt, DE' },
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    let configKey = 'standard';

    if (req.method === 'GET') {
      configKey = req.query?.type || 'standard';
    } else if (req.method === 'POST') {
      configKey = req.body?.type || 'standard';
    }

    const config = ENDPOINT_MAP[configKey];
    if (!config) {
      throw new Error(`Invalid config type: ${configKey}`);
    }

    const keyPair = CryptoUtils.generateKeyPair();

    const cloudflareClient = new CloudflareWarpClient();
    const { id: clientId, token } = await cloudflareClient.registerClient(keyPair.publicKey);
    const warpConfig = await cloudflareClient.enableWarp(clientId, token);

    const peer = warpConfig.result.config.peers[0];
    const interfaceConfig = warpConfig.result.config.interface;

    const finalConfig = WarpConfigBuilder.build({
      privateKey: keyPair.privateKey,
      publicKey: peer.public_key,
      clientIPv4: interfaceConfig.addresses.v4,
      clientIPv6: interfaceConfig.addresses.v6,
      deviceType: config.deviceType,
      endpoint: config.endpoint,
    });

    const configBase64 = CryptoUtils.stringToBase64(finalConfig);

    return res.status(200).json({
      success: true,
      content: configBase64,
      configName: config.name,
      type: configKey
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Ошибка при генерации конфигурации',
    });
  }
}
