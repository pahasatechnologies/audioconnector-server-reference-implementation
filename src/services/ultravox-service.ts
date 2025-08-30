import { WebSocket } from 'ws';
import EventEmitter from 'events';

export interface UltravoxConfig {
    apiKey: string;
    systemPrompt?: string;
    model?: string;
    voice?: string;
    sampleRate?: number;
}

export interface UltravoxCallResponse {
    joinUrl: string;
    callId: string;
}

export class UltravoxService extends EventEmitter {
    private config: UltravoxConfig;
    private ws: WebSocket | null = null;
    private isConnected = false;
    private callId: string | null = null;
    private lastInputSample = 0;
    private lastOutputSample = 0;

    // µ-law conversion lookup tables for performance
    private ulawToLinearTable: Int16Array;
    private linearToUlawTable: Uint8Array;

    constructor(config: UltravoxConfig) {
        super();
        this.config = {
            systemPrompt: "You are a helpful customer service assistant. Please respond naturally and engage in conversation.",
            model: "fixie-ai/ultravox",
            voice: "Riya-Rao-English-Indian",
            sampleRate: 8000,
            ...config
        };
        this.initializeLookupTables();
    }

    private initializeLookupTables() {
        // Create µ-law to linear lookup table
        this.ulawToLinearTable = new Int16Array(256);
        for (let i = 0; i < 256; i++) {
            this.ulawToLinearTable[i] = this.ulawToLinearSlow(i);
        }

        // Create linear to µ-law lookup table
        this.linearToUlawTable = new Uint8Array(65536);
        for (let i = 0; i < 65536; i++) {
            const sample = i - 32768; // Convert to signed
            this.linearToUlawTable[i] = this.linearToUlawSlow(sample);
        }
    }

    private ulawToLinearSlow(ulawByte: number): number {
        const BIAS = 0x84;
        ulawByte = ~ulawByte & 0xff;
        const sign = ulawByte & 0x80;
        const exponent = (ulawByte >> 4) & 0x07;
        const mantissa = ulawByte & 0x0f;

        let sample = (mantissa << 3) + BIAS;
        sample <<= exponent;
        sample -= BIAS;

        return sign ? -sample : sample;
    }

    private linearToUlawSlow(sample: number): number {
        const BIAS = 0x84;
        const CLIP = 32635;

        sample = Math.max(-32768, Math.min(32767, Math.round(sample)));
        const sign = (sample >> 8) & 0x80;
        if (sign) sample = -sample;

        if (sample > CLIP) sample = CLIP;
        sample += BIAS;

        let exponent = 7;
        const expLuts = [0x4000, 0x2000, 0x1000, 0x800, 0x400, 0x200, 0x100];
        for (const expLut of expLuts) {
            if (sample >= expLut) break;
            exponent--;
        }

        const mantissa = (sample >> (exponent + 3)) & 0x0f;
        return ~(sign | (exponent << 4) | mantissa) & 0xff;
    }

    private ulawToLinear(ulawByte: number): number {
        return this.ulawToLinearTable[ulawByte];
    }

    private linearToUlaw(sample: number): number {
        const index = Math.max(0, Math.min(65535, sample + 32768));
        return this.linearToUlawTable[index];
    }

    private applySmoothingFilter(samples: number[], previousSample = 0): { smoothedSamples: number[], lastSample: number } {
        if (samples.length === 0) return { smoothedSamples: samples, lastSample: previousSample };

        const smoothedSamples = new Array(samples.length);
        const alpha = 0.95; // Smoothing factor

        smoothedSamples[0] = alpha * samples[0] + (1 - alpha) * previousSample;

        for (let i = 1; i < samples.length; i++) {
            smoothedSamples[i] = alpha * samples[i] + (1 - alpha) * smoothedSamples[i - 1];
        }

        return {
            smoothedSamples,
            lastSample: smoothedSamples[smoothedSamples.length - 1],
        };
    }

    private applyNoiseGate(samples: number[], threshold = 100): number[] {
        return samples.map((sample) => {
            return Math.abs(sample) < threshold ? 0 : sample;
        });
    }

    private applySoftLimiting(samples: number[], limit = 30000): number[] {
        return samples.map((sample) => {
            if (Math.abs(sample) > limit) {
                const sign = sample >= 0 ? 1 : -1;
                const compressed = Math.tanh(Math.abs(sample) / limit) * limit;
                return sign * compressed;
            }
            return sample;
        });
    }

    private convertPcmuToPcm16(pcmuBuffer: Uint8Array): Buffer {
        const pcmuData = Array.from(pcmuBuffer);
        const linearSamples = pcmuData.map((byte) => this.ulawToLinear(byte));

        // Apply audio processing
        const processedSamples = this.applyNoiseGate(linearSamples, 50);
        const limitedSamples = this.applySoftLimiting(processedSamples, 28000);

        // Apply smoothing
        const { smoothedSamples, lastSample } = this.applySmoothingFilter(
            limitedSamples,
            this.lastInputSample
        );
        this.lastInputSample = lastSample;

        // Convert to PCM16 bytes
        const pcmData = new Array(smoothedSamples.length * 2);
        for (let i = 0; i < smoothedSamples.length; i++) {
            const sample = Math.round(smoothedSamples[i]);
            pcmData[i * 2] = sample & 0xff;
            pcmData[i * 2 + 1] = (sample >> 8) & 0xff;
        }

        return Buffer.from(pcmData);
    }

    private convertPcm16ToPcmu(pcm16Buffer: Buffer): Buffer {
        const pcmBytes = Array.from(pcm16Buffer);
        const linearSamples = [];

        // Convert PCM16 bytes to linear samples
        for (let i = 0; i < pcmBytes.length - 1; i += 2) {
            const lowByte = pcmBytes[i];
            const highByte = pcmBytes[i + 1];
            let sample = lowByte | (highByte << 8);

            // Handle signed 16-bit
            if (sample > 32767) {
                sample -= 65536;
            }
            linearSamples.push(sample);
        }

        // Apply audio processing
        const processedSamples = this.applyNoiseGate(linearSamples, 50);
        const limitedSamples = this.applySoftLimiting(processedSamples, 28000);

        // Apply smoothing
        const { smoothedSamples, lastSample } = this.applySmoothingFilter(
            limitedSamples,
            this.lastOutputSample
        );
        this.lastOutputSample = lastSample;

        // Convert to µ-law
        const pcmuData = smoothedSamples.map((sample) => this.linearToUlaw(Math.round(sample)));

        return Buffer.from(pcmuData);
    }

    async createCall(): Promise<string> {
        const url = "https://api.ultravox.ai/api/calls";
        const headers = {
            "X-API-Key": this.config.apiKey,
            "Content-Type": "application/json",
        };

        const payload = {
            systemPrompt: this.config.systemPrompt,
            model: this.config.model,
            voice: this.config.voice,
            medium: {
                serverWebSocket: {
                    inputSampleRate: this.config.sampleRate,
                    outputSampleRate: this.config.sampleRate,
                },
            },
            vadSettings: {
                turnEndpointDelay: "0.8s",
                minimumTurnDuration: "0.2s",
                minimumInterruptionDuration: "0.3s",
                frameActivationThreshold: 0.2,
            },
            firstSpeaker: "FIRST_SPEAKER_AGENT",
        };

        try {
            const response = await fetch(url, {
                method: "POST",
                headers: headers,
                body: JSON.stringify(payload),
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const data = await response.json() as UltravoxCallResponse;
            this.callId = data.callId;
            return data.joinUrl;
        } catch (error) {
            console.error("Ultravox API request failed:", error);
            throw error;
        }
    }

    async connect(): Promise<void> {
        if (this.isConnected) {
            throw new Error('Already connected to Ultravox');
        }

        try {
            const joinUrl = await this.createCall();
            console.log('Connecting to Ultravox...');

            this.ws = new WebSocket(joinUrl);

            return new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    reject(new Error("Ultravox connection timeout"));
                }, 15000);

                this.ws!.on('open', () => {
                    clearTimeout(timeout);
                    this.isConnected = true;
                    console.log('Connected to Ultravox successfully');
                    this.emit('connected');
                    resolve();
                });

                this.ws!.on('error', (error) => {
                    clearTimeout(timeout);
                    console.error('Ultravox connection error:', error);
                    this.emit('error', error);
                    reject(error);
                });

                this.ws!.on('close', () => {
                    this.isConnected = false;
                    console.log('Ultravox connection closed');
                    this.emit('disconnected');
                });

                this.ws!.on('message', (data) => {
                    if (Buffer.isBuffer(data)) {
                        // Convert PCM16 to PCMU for Genesys
                        const pcmuBuffer = this.convertPcm16ToPcmu(data);
                        this.emit('audio', pcmuBuffer);
                    } else {
                        // Handle text messages from Ultravox
                        try {
                            const message = JSON.parse(data.toString());
                            this.emit('message', message);
                        } catch (error) {
                            console.error('Failed to parse Ultravox message:', error);
                        }
                    }
                });
            });
        } catch (error) {
            console.error('Failed to connect to Ultravox:', error);
            throw error;
        }
    }

    sendAudio(pcmuBuffer: Uint8Array): void {
        if (!this.isConnected || !this.ws) {
            console.warn('Cannot send audio: not connected to Ultravox');
            return;
        }

        try {
            // Convert PCMU to PCM16 for Ultravox
            const pcm16Buffer = this.convertPcmuToPcm16(pcmuBuffer);
            this.ws.send(pcm16Buffer);
        } catch (error) {
            console.error('Error sending audio to Ultravox:', error);
            this.emit('error', error);
        }
    }

    sendMessage(message: any): void {
        if (!this.isConnected || !this.ws) {
            console.warn('Cannot send message: not connected to Ultravox');
            return;
        }

        try {
            this.ws.send(JSON.stringify(message));
        } catch (error) {
            console.error('Error sending message to Ultravox:', error);
            this.emit('error', error);
        }
    }

    disconnect(): void {
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        this.isConnected = false;
        this.callId = null;
    }

    getCallId(): string | null {
        return this.callId;
    }

    getConnectionStatus(): boolean {
        return this.isConnected;
    }
}