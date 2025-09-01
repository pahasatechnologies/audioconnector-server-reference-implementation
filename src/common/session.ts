import { v4 as uuid } from "uuid";
import { WebSocket } from "ws";
import { MessageHandlerRegistry } from "./message-handlers/message-handler-registry.js";
import { UltravoxService } from "../services/ultravox-service.js";
import { DTMFService } from "../services/dtmf-service.js";

export class Session {
  constructor(ws, sessionId, url, phoneNumber) {
    this.MAXIMUM_BINARY_MESSAGE_SIZE = 64000;
    this.disconnecting = false;
    this.closed = false;
    this.ws = ws;

    this.messageHandlerRegistry = new MessageHandlerRegistry();
    this.ultravoxService = null;
    this.dtmfService = null;
    this.url = url;
    this.clientSessionId = sessionId;
    this.userPhoneNumber = phoneNumber; // Store the dynamic phone number
    this.conversationId = undefined;
    this.lastServerSequenceNumber = 0;
    this.lastClientSequenceNumber = 0;
    this.inputVariables = {};
    this.selectedMedia = undefined;
    this.isCapturingDTMF = false;
    this.isAudioPlaying = false;

    // Rate limiting properties
    this.audioBuffer = [];
    this.audioBufferSize = 0;
    this.maxAudioBufferSize = 16000; // 2 seconds at 8kHz
    this.audioSendInterval = null;
    this.audioSendRate = 100; // Send every 100ms
    
    // Transcript rate limiting
    this.lastTranscriptSent = 0;
    this.transcriptMinInterval = 50; // Minimum 50ms between transcripts
    this.transcriptBuffer = null;
    this.transcriptTimer = null;
    
    // General message rate limiting
    this.messageQueue = [];
    this.isProcessingQueue = false;
    this.messageInterval = 20; // 20ms between messages
    
    // Audio chunk size control
    this.audioChunkSize = 1600; // 200ms chunks at 8kHz
  }

  close() {
    if (this.closed) {
      return;
    }

    // Clear all timers and intervals
    if (this.audioSendInterval) {
      clearInterval(this.audioSendInterval);
    }
    if (this.transcriptTimer) {
      clearTimeout(this.transcriptTimer);
    }

    if (this.ultravoxService) {
      this.ultravoxService.disconnect();
    }

    try {
      this.ws.close();
    } catch {}
    console.log("***********************");
    this.closed = true;
  }

  setConversationId(conversationId) {
    this.conversationId = conversationId;
  }

  setInputVariables(inputVariables) {
    this.inputVariables = inputVariables;
  }

  setSelectedMedia(selectedMedia) {
    this.selectedMedia = selectedMedia;
  }

  setIsAudioPlaying(isAudioPlaying) {
    this.isAudioPlaying = isAudioPlaying;
  }

  // Rate-limited message sending
  queueMessage(message) {
    this.messageQueue.push(message);
    this.processMessageQueue();
  }

  async processMessageQueue() {
    if (this.isProcessingQueue || this.messageQueue.length === 0) {
      return;
    }

    this.isProcessingQueue = true;

    while (this.messageQueue.length > 0) {
      const message = this.messageQueue.shift();
      this.sendImmediate(message);
      
      // Wait before sending next message
      if (this.messageQueue.length > 0) {
        await this.delay(this.messageInterval);
      }
    }

    this.isProcessingQueue = false;
  }

  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  processTextMessage(data) {
    if (this.closed) {
      return;
    }

    const message = JSON.parse(data);

    if (message.seq !== this.lastClientSequenceNumber + 1) {
      console.log(`Invalid client sequence number: ${message.seq}.`);
      this.sendDisconnect("error", "Invalid client sequence number.", {});
      return;
    }

    this.lastClientSequenceNumber = message.seq;

    if (message.serverseq > this.lastServerSequenceNumber) {
      console.log(`Invalid server sequence number: ${message.serverseq}.`);
      this.sendDisconnect("error", "Invalid server sequence number.", {});
      return;
    }

    if (message.id !== this.clientSessionId) {
      console.log(`Invalid Client Session ID: ${message.id}.`);
      this.sendDisconnect("error", "Invalid ID specified.", {});
      return;
    }

    const handler = this.messageHandlerRegistry.getHandler(message.type);

    if (!handler) {
      console.log(`Cannot find a message handler for '${message.type}'.`);
      return;
    }

    handler.handleMessage(message, this);
  }

  createMessage(type, parameters) {
    const message = {
      id: this.clientSessionId,
      version: "2",
      seq: ++this.lastServerSequenceNumber,
      clientseq: this.lastClientSequenceNumber,
      type,
      parameters,
    };

    return message;
  }

  // Original send method now queues messages for rate limiting
  send(message) {
    this.queueMessage(message);
  }

  // Immediate send without rate limiting (for critical messages)
  sendImmediate(message) {
    if (this.closed || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    if (message.type === "event") {
      console.log(
        `Sending an ${message.type} message: ${message.parameters.entities[0].type}.`
      );
    } else {
      console.log(`Sending a ${message.type} message.`);
    }

    this.ws.send(JSON.stringify(message));
  }

  // Buffered audio sending with rate limiting
  sendAudio(bytes) {
    if (this.closed) {
      return;
    }

    // Add to buffer
    this.audioBuffer.push(bytes);
    this.audioBufferSize += bytes.length;

    // Start interval if not already running
    if (!this.audioSendInterval) {
      this.audioSendInterval = setInterval(() => {
        this.flushAudioBuffer();
      }, this.audioSendRate);
    }

    // If buffer is too large, flush immediately
    if (this.audioBufferSize >= this.maxAudioBufferSize) {
      this.flushAudioBuffer();
    }
  }

  flushAudioBuffer() {
    if (this.audioBuffer.length === 0 || this.closed) {
      return;
    }

    // Combine all buffered audio
    const totalSize = this.audioBufferSize;
    const combinedBuffer = new Uint8Array(totalSize);
    let offset = 0;

    for (const buffer of this.audioBuffer) {
      combinedBuffer.set(buffer, offset);
      offset += buffer.length;
    }

    // Clear buffer
    this.audioBuffer = [];
    this.audioBufferSize = 0;

    // Send in chunks
    this.sendAudioChunked(combinedBuffer);
  }

  sendAudioChunked(bytes) {
    if (bytes.length <= this.audioChunkSize) {
      console.log(`Sending ${bytes.length} binary bytes in 1 message.`);
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(bytes, { binary: true });
      }
    } else {
      let currentPosition = 0;
      const sendNextChunk = () => {
        if (currentPosition >= bytes.length || this.closed) {
          return;
        }

        const endPosition = Math.min(currentPosition + this.audioChunkSize, bytes.length);
        const sendBytes = bytes.slice(currentPosition, endPosition);

        console.log(`Sending ${sendBytes.length} binary bytes in chunked message.`);
        
        if (this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(sendBytes, { binary: true });
        }
        
        currentPosition = endPosition;

        // Schedule next chunk
        if (currentPosition < bytes.length) {
          setTimeout(sendNextChunk, 10); // 10ms delay between chunks
        }
      };

      sendNextChunk();
    }
  }

  // Rate-limited transcript sending
  sendTranscription(transcript, confidence, isFinal, role) {
    const now = Date.now();
    
    // Store the latest transcript
    this.transcriptBuffer = { transcript, confidence, isFinal, role };

    // If it's final, send immediately
    if (isFinal) {
      this.sendTranscriptionImmediate(transcript, confidence, isFinal);
      return;
    }

    // For non-final transcripts, use debouncing
    if (this.transcriptTimer) {
      clearTimeout(this.transcriptTimer);
    }

    // Only send if enough time has passed since last transcript
    if (now - this.lastTranscriptSent >= this.transcriptMinInterval) {
      this.sendTranscriptionImmediate(transcript, confidence, isFinal, role);
    } else {
      // Schedule delayed send
      this.transcriptTimer = setTimeout(() => {
        if (this.transcriptBuffer) {
          this.sendTranscriptionImmediate(
            this.transcriptBuffer.transcript,
            this.transcriptBuffer.confidence,
            this.transcriptBuffer.isFinal,
            this.transcriptBuffer.role,
          );
        }
      }, this.transcriptMinInterval - (now - this.lastTranscriptSent));
    }
  }

  sendTranscriptionImmediate(transcript, confidence, isFinal, role) {
    const channel = this.selectedMedia?.channels[0];

    if (channel) {
      const parameters = {
        id: uuid(),
        // channelId: channel,
        channelId: role === 'user' ? 0 : 1,
        isFinal,
        alternatives: [
          {
            confidence,
            interpretations: [
              {
                type: "normalized",
                transcript,
              },
            ],
          },
        ],
      };
      const transcriptEvent = {
        type: "transcript",
        data: parameters,
      };
      const message = this.createMessage("event", {
        entities: [transcriptEvent],
      });

      console.log(
        `${new Date().toISOString()}:[Session] Sending transcript: ${transcript}, confidence=${confidence}, isFinal=${isFinal}`
      );
      
      this.queueMessage(message);
      this.lastTranscriptSent = Date.now();
    } else {
      console.log(
        `${new Date().toISOString()}:[Session] Cannot send transcript: no channel available`
      );
    }
  }

  sendTurnResponse(disposition, text, confidence) {
    const botTurnResponseEvent = {
      type: "bot_turn_response",
      data: {
        disposition,
        text,
        confidence,
      },
    };
    const message = this.createMessage("event", {
      entities: [botTurnResponseEvent],
    });

    this.queueMessage(message);
  }

  sendBargeIn() {
    const bargeInEvent = {
      type: "barge_in",
      data: {},
    };
    const message = this.createMessage("event", {
      entities: [bargeInEvent],
    });

    // Barge-in should be sent immediately as it's time-sensitive
    this.sendImmediate(message);
  }

  sendDisconnect(reason, info, outputVariables) {
    this.disconnecting = true;

    const disconnectParameters = {
      reason,
      info,
      outputVariables,
    };
    const message = this.createMessage("disconnect", disconnectParameters);

    // Disconnect should be sent immediately
    this.sendImmediate(message);
  }

  sendClosed() {
    const message = this.createMessage("closed", {});
    // Close message should be sent immediately
    this.sendImmediate(message);
  }

  checkIfBotExists() {
    return Promise.resolve(true);
  }

  async processBotStart() {
    try {
      await this.initializeUltravox();
      this.sendTurnResponse("match", "Hello! How can I help you today?", 1.0);
    } catch (error) {
      console.error("Error starting bot:", error);
      this.sendDisconnect("error", "Failed to initialize conversation", {});
    }
  }

  async initializeUltravox() {
    this.ultravoxService = new UltravoxService(this.userPhoneNumber);

    this.ultravoxService.on("connected", () => {
      console.log("Ultravox connected successfully");
    });

    this.ultravoxService.on("error", (error) => {
      console.error("Ultravox error:", error);
      this.sendDisconnect("error", "Conversation service error", {});
    });

    this.ultravoxService.on("audio", (audioBuffer) => {
      this.sendAudio(audioBuffer);
    });

    this.ultravoxService.on("message", (message) => {
      this.handleUltravoxMessage(message);
    });

    this.ultravoxService.on("call_started", () => {
      console.log("Ultravox call started");
    });

    this.ultravoxService.on("transcript", (data) => {
      console.log("transcript received:", data.text);
      this.sendTranscription(
        data.text || "(empty transcription)",
        data.isFinal ? 0.98 : 0.9,
        data.isFinal || false,
        data.role
      );
    });

    this.ultravoxService.on("agent_response", (parsedEvent) => {
      console.log("Agent response received:", parsedEvent);
      const text = parsedEvent.text || "Agent responded.";
      this.sendTurnResponse("match", text, 1.0);
    });

    this.ultravoxService.on("state", (parsedEvent) => {
      console.log("State change:", parsedEvent.state);
      if (parsedEvent.state === "done") {
        console.log("Turn ended");
      }
    });

    this.ultravoxService.on("playback_clear_buffer", () => {
      console.log("Clearing playback buffer (interruption)");
      this.sendBargeIn();
      this.setIsAudioPlaying(false);
    });

    this.ultravoxService.on("call_ended", (parsedEvent) => {
      console.log("Call ended:", parsedEvent);
      this.sendDisconnect("complete", "Call ended by Ultravox", {});
    });

    this.ultravoxService.on("debug", (parsedEvent) => {
      console.log("Debug info:", parsedEvent);
    });

    this.ultravoxService.on("pong", () => {
      console.log("Pong received (latency check)");
    });

    this.ultravoxService.on("disconnected", () => {
      console.log("Ultravox disconnected");
      if (!this.disconnecting) {
        this.sendDisconnect("error", "Ultravox disconnected unexpectedly", {});
      }
    });

    await this.ultravoxService.connect();
  }

  handleUltravoxMessage(message) {
    try {
      console.log("&&&&&&&&&&&&&&", JSON.stringify(message));
      if (message.type === "transcript") {
        if (message.isFinal && message.text) {
          this.sendTurnResponse(
            "match",
            message.text,
            message.confidence || 0.9
          );
        }
      } else if (message.type === "agent_response") {
        this.sendTurnResponse("match", message.text, message.confidence || 1.0);
      } else if (message.type === "turn_end") {
        console.log("Turn ended");
      }
    } catch (error) {
      console.error("Error handling Ultravox message:", error);
    }
  }

  processBinaryMessage(data) {
    if (this.disconnecting || this.closed) {
      return;
    }

    if (this.isCapturingDTMF) {
      return;
    }

    if (this.isAudioPlaying) {
      this.sendBargeIn();
      this.setIsAudioPlaying(false);
    }

    if (this.ultravoxService && this.ultravoxService.getConnectionStatus()) {
      // Instead of sending immediately, use rate-limited audio sending
      this.sendAudioToUltravox(data);
    }
  }

  // Rate-limited audio sending to Ultravox
  sendAudioToUltravox(data) {
    // You might also want to rate limit audio to Ultravox
    // For now, sending directly, but you could implement similar buffering
    this.ultravoxService.sendAudio(data);
  }

  processDTMF(digit) {
    if (this.disconnecting || this.closed) {
      return;
    }

    if (this.isAudioPlaying) {
      this.sendBargeIn();
      this.setIsAudioPlaying(false);
    }

    if (!this.isCapturingDTMF) {
      this.isCapturingDTMF = true;
    }

    if (!this.dtmfService || this.dtmfService.getState() === "Complete") {
      this.dtmfService = new DTMFService()
        .on("error", (error) => {
          const message = "Error during DTMF Capture.";
          console.log(`${message}: ${error}`);
          this.sendDisconnect("error", message, {});
        })
        .on("final-digits", (digits) => {
          if (
            this.ultravoxService &&
            this.ultravoxService.getConnectionStatus()
          ) {
            this.ultravoxService.sendMessage({
              type: "user_message",
              text: `DTMF input: ${digits}`,
            });
          }

          this.isCapturingDTMF = false;
        });
    }

    this.dtmfService.processDigit(digit);
  }
}