/**
 * Audio format conversion utilities for AudioConnector
 * Handles conversion between PCMU (µ-law) and PCM16 formats
 */

class AudioConverter {
  private static ulawToLinearTable: Int16Array | null = null;
  private static linearToUlawTable: Uint8Array | null = null;

  /**
   * Initialize lookup tables for efficient conversion
   */
  static initializeLookupTables(): void {
    if (this.ulawToLinearTable && this.linearToUlawTable) {
      return; // Already initialized
    }

    // Initialize µ-law to linear conversion table
    this.ulawToLinearTable = new Int16Array(256);
    for (let i = 0; i < 256; i++) {
      this.ulawToLinearTable[i] = this.ulawToLinear(i);
    }

    // Initialize linear to µ-law conversion table
    this.linearToUlawTable = new Uint8Array(65536);
    for (let i = 0; i < 65536; i++) {
      const sample = i - 32768; // Convert to signed 16-bit
      this.linearToUlawTable[i] = this.linearToUlaw(sample);
    }
  }

  /**
   * Convert a single µ-law sample to linear PCM
   */
  private static ulawToLinear(ulawSample: number): number {
    ulawSample = ~ulawSample;
    const sign = ulawSample & 0x80;
    const exponent = (ulawSample >> 4) & 0x07;
    const mantissa = ulawSample & 0x0F;
    
    let sample = mantissa << (exponent + 3);
    if (exponent !== 0) {
      sample += (1 << (exponent + 2));
    }
    
    return sign ? -sample : sample;
  }

  /**
   * Convert a single linear PCM sample to µ-law
   */
  private static linearToUlaw(linearSample: number): number {
    const sign = linearSample < 0 ? 0x80 : 0x00;
    let sample = Math.abs(linearSample);
    
    // Clip to maximum value
    if (sample > 32635) sample = 32635;
    
    // Add bias
    sample += 33;
    
    // Find exponent
    let exponent = 0;
    let temp = sample >> 6;
    while (temp !== 0 && exponent < 7) {
      temp >>= 1;
      exponent++;
    }
    
    // Find mantissa
    const mantissa = (sample >> (exponent + 3)) & 0x0F;
    
    // Combine and invert
    return ~(sign | (exponent << 4) | mantissa) & 0xFF;
  }

  /**
   * Convert PCMU (µ-law) buffer to PCM16 (linear) buffer
   */
  static convertPcmuToPcm16(pcmuBuffer: Uint8Array): Uint8Array {
    if (!this.ulawToLinearTable) {
      this.initializeLookupTables();
    }

    const pcm16Buffer = new ArrayBuffer(pcmuBuffer.length * 2);
    const pcm16View = new Int16Array(pcm16Buffer);

    for (let i = 0; i < pcmuBuffer.length; i++) {
      pcm16View[i] = this.ulawToLinearTable![pcmuBuffer[i]];
    }

    return new Uint8Array(pcm16Buffer);
  }

  /**
   * Convert PCM16 (linear) buffer to PCMU (µ-law) buffer
   */
  static convertPcm16ToPcmu(pcm16Buffer: Uint8Array): Uint8Array {
    if (!this.linearToUlawTable) {
      this.initializeLookupTables();
    }

    const pcm16View = new Int16Array(pcm16Buffer.buffer);
    const pcmuBuffer = new Uint8Array(pcm16View.length);

    for (let i = 0; i < pcm16View.length; i++) {
      const unsignedSample = pcm16View[i] + 32768; // Convert to unsigned
      pcmuBuffer[i] = this.linearToUlawTable![unsignedSample];
    }

    return pcmuBuffer;
  }

  /**
   * Apply noise gate to reduce background noise
   */
  static applyNoiseGate(buffer: Uint8Array, threshold: number = 500): Uint8Array {
    const pcm16View = new Int16Array(buffer.buffer);
    
    for (let i = 0; i < pcm16View.length; i++) {
      if (Math.abs(pcm16View[i]) < threshold) {
        pcm16View[i] = 0;
      }
    }
    
    return new Uint8Array(pcm16View.buffer);
  }

  /**
   * Apply soft limiting to prevent clipping
   */
  static applySoftLimiting(buffer: Uint8Array, threshold: number = 28000): Uint8Array {
    const pcm16View = new Int16Array(buffer.buffer);
    
    for (let i = 0; i < pcm16View.length; i++) {
      const sample = pcm16View[i];
      const absample = Math.abs(sample);
      
      if (absample > threshold) {
        const ratio = threshold / absample;
        const softRatio = ratio + (1 - ratio) * 0.3; // Soft knee
        pcm16View[i] = Math.round(sample * softRatio);
      }
    }
    
    return new Uint8Array(pcm16View.buffer);
  }

  /**
   * Smooth audio transitions to reduce clicks and pops
   */
  static smoothTransition(buffer: Uint8Array, fadeLength: number = 10): Uint8Array {
    const pcm16View = new Int16Array(buffer.buffer);
    
    // Fade in
    for (let i = 0; i < Math.min(fadeLength, pcm16View.length); i++) {
      const factor = i / fadeLength;
      pcm16View[i] = Math.round(pcm16View[i] * factor);
    }
    
    // Fade out
    const startFadeOut = Math.max(0, pcm16View.length - fadeLength);
    for (let i = startFadeOut; i < pcm16View.length; i++) {
      const factor = (pcm16View.length - i) / fadeLength;
      pcm16View[i] = Math.round(pcm16View[i] * factor);
    }
    
    return new Uint8Array(pcm16View.buffer);
  }
}

export default AudioConverter;