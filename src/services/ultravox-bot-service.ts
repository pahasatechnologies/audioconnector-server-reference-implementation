import { JsonStringMap } from "../protocol/core";
import { BotTurnDisposition } from "../protocol/voice-bots";
import { UltravoxService } from "./ultravox-service";

export interface UltravoxBotResponse {
    disposition: BotTurnDisposition;
    text?: string;
    confidence?: number;
    audioBytes?: Uint8Array;
    endSession?: boolean;
}

export class UltravoxBotService {
    private apiKey: string;

    constructor(apiKey: string) {
        this.apiKey = apiKey;
    }

    getBotIfExists(connectionUrl: string, inputVariables: JsonStringMap): Promise<UltravoxBotResource | null> {
        // In a real implementation, you might parse the URL or input variables
        // to determine bot configuration or validate access
        return Promise.resolve(new UltravoxBotResource(this.apiKey, inputVariables));
    }
}

export class UltravoxBotResource {
    private ultravoxService: UltravoxService;
    private inputVariables: JsonStringMap;
    private isInitialized = false;

    constructor(apiKey: string, inputVariables: JsonStringMap = {}) {
        this.inputVariables = inputVariables;
        
        // Create system prompt based on input variables or use default
        const systemPrompt = this.createSystemPrompt(inputVariables);
        
        this.ultravoxService = new UltravoxService({
            apiKey,
            systemPrompt,
            model: "fixie-ai/ultravox",
            voice: "Riya-Rao-English-Indian"
        });

        this.setupEventHandlers();
    }

    private createSystemPrompt(inputVariables: JsonStringMap): string {
        // Customize system prompt based on input variables
        let prompt = "You are a helpful customer service assistant. ";
        
        if (inputVariables.department) {
            prompt += `You work in the ${inputVariables.department} department. `;
        }
        
        if (inputVariables.customerType) {
            prompt += `You are assisting a ${inputVariables.customerType} customer. `;
        }

        prompt += "Please be polite, professional, and helpful. Keep responses concise but informative.";
        
        return prompt;
    }

    private setupEventHandlers() {
        this.ultravoxService.on('error', (error) => {
            console.error('Ultravox bot error:', error);
        });

        this.ultravoxService.on('disconnected', () => {
            console.log('Ultravox bot disconnected');
        });
    }

    async getInitialResponse(): Promise<UltravoxBotResponse> {
        try {
            if (!this.isInitialized) {
                await this.ultravoxService.connect();
                this.isInitialized = true;
            }

            // Wait for initial response from Ultravox
            return new Promise((resolve) => {
                const timeout = setTimeout(() => {
                    resolve({
                        disposition: 'match',
                        text: 'Hello! How can I help you today?',
                        confidence: 1.0
                    });
                }, 2000);

                this.ultravoxService.once('audio', (audioBuffer) => {
                    clearTimeout(timeout);
                    resolve({
                        disposition: 'match',
                        text: 'Hello! How can I help you today?',
                        confidence: 1.0,
                        audioBytes: audioBuffer
                    });
                });

                this.ultravoxService.once('message', (message) => {
                    if (message.type === 'agent_response') {
                        clearTimeout(timeout);
                        resolve({
                            disposition: 'match',
                            text: message.text,
                            confidence: message.confidence || 1.0
                        });
                    }
                });
            });
        } catch (error) {
            console.error('Error getting initial response:', error);
            return {
                disposition: 'no_match',
                text: 'I apologize, but I\'m having trouble connecting right now. Please try again.',
                confidence: 0.5
            };
        }
    }

    async getBotResponse(data: string): Promise<UltravoxBotResponse> {
        try {
            if (!this.isInitialized) {
                await this.ultravoxService.connect();
                this.isInitialized = true;
            }

            // Send the user input to Ultravox
            this.ultravoxService.sendMessage({
                type: 'user_message',
                text: data
            });

            // Wait for response from Ultravox
            return new Promise((resolve) => {
                const timeout = setTimeout(() => {
                    resolve({
                        disposition: 'no_match',
                        text: 'I apologize, but I didn\'t catch that. Could you please repeat?',
                        confidence: 0.3
                    });
                }, 5000);

                this.ultravoxService.once('audio', (audioBuffer) => {
                    clearTimeout(timeout);
                    resolve({
                        disposition: 'match',
                        confidence: 0.9,
                        audioBytes: audioBuffer
                    });
                });

                this.ultravoxService.once('message', (message) => {
                    if (message.type === 'agent_response') {
                        clearTimeout(timeout);
                        
                        // Check if this should end the session
                        const shouldEndSession = this.shouldEndSession(message.text || data);
                        
                        resolve({
                            disposition: 'match',
                            text: message.text,
                            confidence: message.confidence || 0.9,
                            endSession: shouldEndSession
                        });
                    }
                });
            });
        } catch (error) {
            console.error('Error getting bot response:', error);
            return {
                disposition: 'no_match',
                text: 'I apologize, but I\'m having trouble processing your request right now.',
                confidence: 0.3
            };
        }
    }

    private shouldEndSession(text: string): boolean {
        // Simple logic to determine if session should end
        const endPhrases = [
            'goodbye',
            'bye',
            'thank you',
            'that\'s all',
            'end call',
            'hang up'
        ];

        const lowerText = text.toLowerCase();
        return endPhrases.some(phrase => lowerText.includes(phrase));
    }

    disconnect(): void {
        this.ultravoxService.disconnect();
        this.isInitialized = false;
    }
}