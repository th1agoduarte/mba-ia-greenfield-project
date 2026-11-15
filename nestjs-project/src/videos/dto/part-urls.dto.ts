import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsInt,
  Max,
  Min,
} from 'class-validator';
import { VIDEO_UPLOAD } from '../videos.constants';

export class PartUrlsDto {
  /** Part numbers to sign (1-based); up to 100 per request. */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(VIDEO_UPLOAD.MAX_URLS_PER_REQUEST)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(VIDEO_UPLOAD.MAX_PARTS, { each: true })
  part_numbers: number[];
}
