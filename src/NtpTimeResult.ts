export interface NtpTimeResult {
  // Correct real time
  now: Date;

  // Offset local to real time in milliseconds
  offset: number;

  // Precision in milliseconds
  precision: number;
}
