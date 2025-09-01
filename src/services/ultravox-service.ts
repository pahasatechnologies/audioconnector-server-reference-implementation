import { WebSocket } from "ws";
import EventEmitter from "events";
import AudioConverter from "../utils/audio-converter.js";
import config from "../config/config.js";
import { getCurrentAgentStageConfig } from "../utils/promptUtils.js";
import { logger } from "../utils/logger.js";
import { updateActiveCall } from "../controllers/callController.js";

const DEFAULT_AGENT_CONFIG = config.DEFAULT_AGENT_CONFIG;
const MODELS = config.MODELS;

const ULTRAVOX_API_URL = process.env.ULTRAVOX_CALL_API + "/calls";
const ULTRAVOX_API_KEY = process.env.ULTRAVOX_API_KEY;

const ULTRAVOX_SAMPLE_RATE = 8000;
const USER_MOBILE_NUMBER = process.env.USER_MOBILE_NUMBER || "+919898989898";
const GENESYS_USER_NAME = process.env.INCOMING_CALL_CONFIG || "genesys";

export class UltravoxService extends EventEmitter {
  constructor(phoneNumber = null) {
    super();

    this.userPhoneNumber = phoneNumber || USER_MOBILE_NUMBER;
    this.userName = GENESYS_USER_NAME;
    this.ultravoxWs = null;
    this.isConnected = false;
    this.callId = null;
    this.lastInputSample = 0;
    this.lastOutputSample = 0;

    this.ulawToLinearTable = null;
    this.linearToUlawTable = null;

    // Rate limiting for audio
    this.audioQueue = [];
    this.audioSendInterval = null;
    this.audioSendRate = 50; // Send every 50ms
    this.maxAudioQueueSize = 10; // Maximum queued audio chunks

    // Rate limiting for messages
    this.messageQueue = [];
    this.isProcessingMessages = false;
    this.messageDelay = 10; // 10ms between messages

    // Transcript throttling
    this.lastTranscriptTime = 0;
    this.transcriptThrottleMs = 100; // Minimum 100ms between transcript emissions

    AudioConverter.initializeLookupTables();

    logger.info(
      `UltravoxService initialized with phone number: ${this.userPhoneNumber}`
    );
  }

  async buildCallConfig() {
    const agentConfig = await getCurrentAgentStageConfig(
      this.userPhoneNumber,
      this.userName,
      ""
    );

    const voice = agentConfig?.config?.voice || DEFAULT_AGENT_CONFIG.voice;
    const model = agentConfig?.config?.model || DEFAULT_AGENT_CONFIG.model;
    const temperature =
      agentConfig?.config?.temperature || DEFAULT_AGENT_CONFIG.temperature;
    const firstSpeaker =
      agentConfig?.config?.firstSpeaker || DEFAULT_AGENT_CONFIG.firstSpeaker;
    const systemPrompt =
      (agentConfig?.systemPrompt || "") +
        ` user mobile number is ${this.userPhoneNumber}` || "";
    const toolsSchema = agentConfig?.toolsSchema || [];

    const inactivityMessages =
      agentConfig?.config?.inactivityMessages ||
      DEFAULT_AGENT_CONFIG.inactivityMessages;

    return {
      systemPrompt,
      model: MODELS[model] || model,
      voice,
      temperature,
      firstSpeaker,
      selectedTools: toolsSchema,
      inactivityMessages,
      medium: {
        serverWebSocket: {
          inputSampleRate: ULTRAVOX_SAMPLE_RATE,
          outputSampleRate: ULTRAVOX_SAMPLE_RATE,
          clientBufferSizeMs: 60,
        },
      },
      vadSettings: {
        turnEndpointDelay: "0.8s",
        minimumTurnDuration: "0.2s",
        minimumInterruptionDuration: "0.3s",
        frameActivationThreshold: 0.2,
      },
    };
  }

  getUserPhoneNumber() {
    return this.userPhoneNumber;
  }

  setUserPhoneNumber(phoneNumber) {
    this.userPhoneNumber = phoneNumber;
    console.log(`Phone number updated to: ${this.userPhoneNumber}`);
  }

  async createCall() {
    if (!ULTRAVOX_API_KEY) throw new Error("Ultravox API key not configured");
    if (!ULTRAVOX_API_URL) throw new Error("Ultravox API URL not configured");

    const callConfig = await this.buildCallConfig();

    const headers = {
      "Content-Type": "application/json",
      "X-API-Key": ULTRAVOX_API_KEY,
    };

    try {
      const response = await fetch(ULTRAVOX_API_URL, {
        method: "POST",
        headers,
        body: JSON.stringify(callConfig),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const ultravoxData = await response.json();
      this.callId = ultravoxData.callId;

      updateActiveCall({
        ...ultravoxData,
        userMobile: this.userPhoneNumber,
        callType: "twilio"
      });
      return ultravoxData.joinUrl;
    } catch (error) {
      console.error("Ultravox API request failed:", error);
      throw error;
    }
  }

  async connect() {
    if (this.isConnected) {
      throw new Error("Already connected to Ultravox");
    }

    try {
      const joinUrl = await this.createCall();
      console.log("Connecting to Ultravox...");

      this.ultravoxWs = new WebSocket(joinUrl);

      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("Ultravox connection timeout"));
        }, 15000);

        this.ultravoxWs.on("open", () => {
          clearTimeout(timeout);
          this.isConnected = true;
          console.log("Connected to Ultravox successfully");
          this.startAudioProcessing();
          this.emit("connected");
          resolve();
        });

        this.ultravoxWs.on("error", (error) => {
          clearTimeout(timeout);
          console.error("Ultravox connection error:", error);
          this.emit("error", error);
          reject(error);
        });

        this.ultravoxWs.on("close", () => {
          this.isConnected = false;
          this.stopAudioProcessing();
          console.log("Ultravox connection closed");
          this.emit("disconnected");
        });

        this.ultravoxWs.on("message", (data, isBinary) => {
          this.handleEvent(data, isBinary);
        });
      });
    } catch (error) {
      console.error("Failed to connect to Ultravox:", error);
      throw error;
    }
  }

  startAudioProcessing() {
    if (this.audioSendInterval) {
      clearInterval(this.audioSendInterval);
    }

    this.audioSendInterval = setInterval(() => {
      this.processAudioQueue();
    }, this.audioSendRate);
  }

  stopAudioProcessing() {
    if (this.audioSendInterval) {
      clearInterval(this.audioSendInterval);
      this.audioSendInterval = null;
    }
    this.audioQueue = [];
  }

  processAudioQueue() {
    if (this.audioQueue.length === 0 || !this.isConnected) {
      return;
    }

    const audioData = this.audioQueue.shift();
    try {
      const pcm16Buffer = AudioConverter.convertPcmuToPcm16(audioData);
      if (this.ultravoxWs && this.ultravoxWs.readyState === WebSocket.OPEN) {
        this.ultravoxWs.send(pcm16Buffer);
      }
    } catch (error) {
      console.error("Error processing audio from queue:", error);
      this.emit("error", error);
    }
  }

  handleEvent(event, isBinary) {
    try {
      if (isBinary) {
        const pcmuBuffer = AudioConverter.convertPcm16ToPcmu(event);
        this.emit("audio", pcmuBuffer);
        if (this.onMessage) {
          this.onMessage(pcmuBuffer, true);
        }
        return;
      }

      const parsedEvent = JSON.parse(event.toString());
      logger.debug(`Ultravox event received: ${JSON.stringify(parsedEvent)}`);

      switch (parsedEvent.type) {
        case "playback_clear_buffer":
          this.emit("playback_clear_buffer");
          break;
        case "transcript":
          this.handleTranscript(parsedEvent);
          break;
        case "agent_response":
          this.emit("agent_response", parsedEvent);
          break;
        case "call_ended":
          this.emit("call_ended", parsedEvent);
          break;
        case "state":
          if (
            parsedEvent.state === "listening" ||
            parsedEvent.state === "done"
          ) {
            this.emit("state", parsedEvent);
          }
          break;
        case "pong":
          this.emit("pong");
          break;
        case "call_started":
          this.emit("call_started");
          break;
        case "debug":
          this.emit("debug", parsedEvent);
          break;
        case "error":
          this.emit(
            "error",
            new Error(parsedEvent.message || "Unknown Ultravox error")
          );
          break;
        default:
          this.emit("message", parsedEvent);
          break;
      }

      if (this.onMessage) {
        this.onMessage(event, false);
      }
    } catch (error) {
      logger.error(`Error parsing Ultravox event: ${error}`);
      this.emit("error", error);
      if (this.onError) {
        this.onError(error);
      }
    }
  }

  handleTranscript(parsedEvent) {
    const now = Date.now();

    // Throttle transcript events
    if (
      now - this.lastTranscriptTime < this.transcriptThrottleMs &&
      !parsedEvent.final
    ) {
      return; // Skip non-final transcripts that are too frequent
    }

    this.lastTranscriptTime = now;

    this.emit("transcript", {
      text: parsedEvent.delta || "",
      isFinal: parsedEvent.final || false,
      role: parsedEvent.role,
    });
  }

  sendAudio(pcmuBuffer) {
    if (!this.isConnected || !this.ultravoxWs) {
      console.warn("Cannot send audio: not connected to Ultravox");
      return;
    }

    // Add to queue instead of sending immediately
    this.audioQueue.push(pcmuBuffer);

    // Prevent queue from growing too large
    if (this.audioQueue.length > this.maxAudioQueueSize) {
      this.audioQueue.shift(); // Remove oldest audio data
      console.warn("Audio queue overflow, dropping oldest audio data");
    }
  }

  sendMessage(message) {
    if (!this.isConnected || !this.ultravoxWs) {
      console.warn("Cannot send message: not connected to Ultravox");
      return;
    }

    // Add to message queue for rate limiting
    this.messageQueue.push(message);
    this.processMessageQueue();
  }

  async processMessageQueue() {
    if (this.isProcessingMessages || this.messageQueue.length === 0) {
      return;
    }

    this.isProcessingMessages = true;

    while (this.messageQueue.length > 0) {
      const message = this.messageQueue.shift();

      try {
        if (this.ultravoxWs && this.ultravoxWs.readyState === WebSocket.OPEN) {
          this.ultravoxWs.send(JSON.stringify(message));
        }
      } catch (error) {
        console.error("Error sending message to Ultravox:", error);
        this.emit("error", error);
      }

      // Wait before sending next message
      if (this.messageQueue.length > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.messageDelay));
      }
    }

    this.isProcessingMessages = false;
  }

  disconnect() {
    this.stopAudioProcessing();

    if (this.ultravoxWs) {
      this.ultravoxWs.close();
      this.ultravoxWs = null;
    }
    this.isConnected = false;
    this.callId = null;
  }

  getCallId() {
    return this.callId;
  }

  getConnectionStatus() {
    return this.isConnected;
  }
}
