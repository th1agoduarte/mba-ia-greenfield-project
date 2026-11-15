export abstract class DomainException extends Error {
  constructor(
    public readonly errorCode: string,
    public readonly httpStatus: number,
    message: string,
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class EmailAlreadyExistsException extends DomainException {
  constructor() {
    super('EMAIL_ALREADY_EXISTS', 409, 'Email is already registered');
  }
}

export class InvalidCredentialsException extends DomainException {
  constructor() {
    super('INVALID_CREDENTIALS', 401, 'Invalid email or password');
  }
}

export class EmailNotConfirmedException extends DomainException {
  constructor() {
    super('EMAIL_NOT_CONFIRMED', 403, 'Email address has not been confirmed');
  }
}

export class InvalidTokenException extends DomainException {
  constructor() {
    super('INVALID_TOKEN', 401, 'Token is invalid');
  }
}

export class TokenExpiredException extends DomainException {
  constructor() {
    super('TOKEN_EXPIRED', 401, 'Token has expired');
  }
}

export class TokenReuseDetectedException extends DomainException {
  constructor() {
    super(
      'TOKEN_REUSE_DETECTED',
      401,
      'Token reuse detected — all sessions revoked',
    );
  }
}

export class InvalidUploadPartsException extends DomainException {
  constructor() {
    super(
      'INVALID_UPLOAD_PARTS',
      400,
      'The uploaded parts do not match the storage upload (missing part, wrong ETag or order)',
    );
  }
}

export class VideoNotFoundException extends DomainException {
  constructor() {
    super('VIDEO_NOT_FOUND', 404, 'Video not found');
  }
}

export class VideoInvalidStateException extends DomainException {
  constructor(status: string) {
    super(
      'VIDEO_INVALID_STATE',
      409,
      `Operation not allowed for a video in status "${status}"`,
    );
  }
}

export class VideoNotReadyException extends DomainException {
  constructor() {
    super('VIDEO_NOT_READY', 409, 'Video is not ready yet');
  }
}

export class InvalidPartNumberException extends DomainException {
  constructor(partCount: number) {
    super(
      'INVALID_PART_NUMBER',
      400,
      `Part numbers must be between 1 and ${partCount}`,
    );
  }
}

export class UploadTooLargeException extends DomainException {
  constructor() {
    super(
      'UPLOAD_TOO_LARGE',
      400,
      'The uploaded file exceeds the 10 GiB limit',
    );
  }
}

export class ChannelNotFoundException extends DomainException {
  constructor() {
    super(
      'CHANNEL_NOT_FOUND',
      404,
      'The authenticated user has no channel to own the video',
    );
  }
}
