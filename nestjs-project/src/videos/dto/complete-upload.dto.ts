import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { VIDEO_UPLOAD } from '../videos.constants';

export class CompletedPartDto {
  /** Part number (1-based). */
  @IsInt()
  @Min(1)
  @Max(VIDEO_UPLOAD.MAX_PARTS)
  part_number: number;

  /** ETag response header returned by the storage for the part PUT. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  etag: string;
}

export class CompleteUploadDto {
  /** Every uploaded part with its ETag. */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(VIDEO_UPLOAD.MAX_PARTS)
  @ValidateNested({ each: true })
  @Type(() => CompletedPartDto)
  parts: CompletedPartDto[];
}
