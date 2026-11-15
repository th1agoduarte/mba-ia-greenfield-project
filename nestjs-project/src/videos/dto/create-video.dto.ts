import {
  IsInt,
  IsNotEmpty,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { VIDEO_UPLOAD } from '../videos.constants';

export class CreateVideoDto {
  /** Video title shown to the user. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  title: string;

  /** Original file name, used for the download. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  file_name: string;

  /** File size in bytes; at most 10 GiB (10737418240). */
  @IsInt()
  @Min(1)
  @Max(VIDEO_UPLOAD.MAX_SIZE_BYTES)
  file_size: number;

  /** MIME type of the file; must be a video type (e.g. `video/mp4`). */
  @IsString()
  @MaxLength(100)
  @Matches(/^video\/[\w.+-]+$/, {
    message: 'content_type must be a video/* MIME type',
  })
  content_type: string;
}
