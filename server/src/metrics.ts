/**
 * Metrics collection for monitoring and observability
 */

interface MetricData {
  count: number;
  sum: number;
  min: number;
  max: number;
  timestamps: number[];
}

class MetricsCollector {
  private counters: Map<string, number> = new Map();
  private gauges: Map<string, MetricData> = new Map();
  private histograms: Map<string, number[]> = new Map();

  increment(name: string, value: number = 1): void {
    const current = this.counters.get(name) || 0;
    this.counters.set(name, current + value);
  }

  gauge(name: string, value: number): void {
    const current = this.gauges.get(name) || { count: 0, sum: 0, min: Infinity, max: -Infinity, timestamps: [] };
    current.count++;
    current.sum += value;
    current.min = Math.min(current.min, value);
    current.max = Math.max(current.max, value);
    current.timestamps.push(Date.now());
    
    // Keep only last 100 timestamps
    if (current.timestamps.length > 100) {
      current.timestamps.shift();
    }
    
    this.gauges.set(name, current);
  }

  histogram(name: string, value: number): void {
    const current = this.histograms.get(name) || [];
    current.push(value);
    
    // Keep only last 1000 values
    if (current.length > 1000) {
      current.shift();
    }
    
    this.histograms.set(name, current);
  }

  getCounter(name: string): number {
    return this.counters.get(name) || 0;
  }

  getGauge(name: string): MetricData | undefined {
    return this.gauges.get(name);
  }

  getHistogram(name: string): { values: number[]; p50: number; p95: number; p99: number } | undefined {
    const values = this.histograms.get(name);
    if (!values || values.length === 0) return undefined;

    const sorted = [...values].sort((a, b) => a - b);
    const p50 = sorted[Math.floor(sorted.length * 0.5)];
    const p95 = sorted[Math.floor(sorted.length * 0.95)];
    const p99 = sorted[Math.floor(sorted.length * 0.99)];

    return { values: sorted, p50, p95, p99 };
  }

  getAllMetrics(): Record<string, any> {
    const metrics: Record<string, any> = {};

    for (const [name, value] of this.counters.entries()) {
      metrics[`counter_${name}`] = value;
    }

    for (const [name, data] of this.gauges.entries()) {
      metrics[`gauge_${name}_count`] = data.count;
      metrics[`gauge_${name}_sum`] = data.sum;
      metrics[`gauge_${name}_avg`] = data.count > 0 ? data.sum / data.count : 0;
      metrics[`gauge_${name}_min`] = data.min === Infinity ? 0 : data.min;
      metrics[`gauge_${name}_max`] = data.max === -Infinity ? 0 : data.max;
    }

    for (const [name, data] of this.histograms.entries()) {
      const hist = this.getHistogram(name);
      if (hist) {
        metrics[`histogram_${name}_p50`] = hist.p50;
        metrics[`histogram_${name}_p95`] = hist.p95;
        metrics[`histogram_${name}_p99`] = hist.p99;
      }
    }

    return metrics;
  }

  reset(): void {
    this.counters.clear();
    this.gauges.clear();
    this.histograms.clear();
  }
}

// Singleton instance
export const metrics = new MetricsCollector();

// Helper functions for common metrics
export function trackApolloRequest(duration: number, success: boolean): void {
  metrics.histogram('apollo_request_duration_ms', duration);
  metrics.increment(success ? 'apollo_requests_success' : 'apollo_requests_failure');
}

export function trackLLMRequest(provider: string, duration: number, success: boolean): void {
  metrics.histogram(`llm_request_duration_ms_${provider}`, duration);
  metrics.increment(success ? `llm_requests_success_${provider}` : `llm_requests_failure_${provider}`);
}

export function trackLeadProcessing(duration: number, score: number, ready: boolean): void {
  metrics.histogram('lead_processing_duration_ms', duration);
  metrics.gauge('lead_score', score);
  metrics.increment(ready ? 'leads_ready' : 'leads_rejected');
}
