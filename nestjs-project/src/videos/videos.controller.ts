import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { CreateVideoDto } from './dto/create-video.dto';
import { PartUrlsDto } from './dto/part-urls.dto';
import {
  InitiatedUploadDto,
  PartUrlsResponseDto,
  UploadedPartsResponseDto,
  VideoSummaryDto,
} from './dto/video-response.dto';
import { VideosService } from './videos.service';

const ERROR = { $ref: getSchemaPath(ApiErrorEnvelope) };

/**
 * Video upload, processing status, streaming and download. Every route is
 * owner-only; the throttler is skipped because a 10 GiB upload needs many
 * part-URL requests (phase-03-videos/TD-02, TD-08 Revisions).
 */
@ApiTags('videos')
@ApiBearerAuth('access-token')
@ApiResponse({
  status: 401,
  description: 'Missing or invalid access token',
  schema: ERROR,
})
@SkipThrottle()
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post()
  @ApiOperation({
    summary: 'Start a video upload',
    description:
      'Pre-registers the video as draft and opens a multipart upload. The file is sent directly to the object storage through presigned part URLs.',
  })
  @ApiResponse({
    status: 201,
    description: 'Draft created',
    type: InitiatedUploadDto,
  })
  @ApiResponse({ status: 400, description: 'Validation failed', schema: ERROR })
  initiate(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateVideoDto,
  ): Promise<InitiatedUploadDto> {
    return this.videosService.initiateUpload(user.sub, dto);
  }

  @Post(':slug/upload/part-urls')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Get presigned part upload URLs',
    description: 'Returns presigned PUT URLs (1 h) for up to 100 parts.',
  })
  @ApiResponse({
    status: 200,
    description: 'Presigned URLs',
    type: PartUrlsResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid part numbers',
    schema: ERROR,
  })
  @ApiResponse({ status: 404, description: 'Video not found', schema: ERROR })
  @ApiResponse({
    status: 409,
    description: 'Video is not a draft',
    schema: ERROR,
  })
  partUrls(
    @CurrentUser() user: JwtPayload,
    @Param('slug') slug: string,
    @Body() dto: PartUrlsDto,
  ): Promise<PartUrlsResponseDto> {
    return this.videosService.presignParts(user.sub, slug, dto.part_numbers);
  }

  @Get(':slug/upload/parts')
  @ApiOperation({
    summary: 'List uploaded parts',
    description:
      'Lists the parts already stored so an interrupted upload can resume.',
  })
  @ApiResponse({
    status: 200,
    description: 'Stored parts',
    type: UploadedPartsResponseDto,
  })
  @ApiResponse({ status: 404, description: 'Video not found', schema: ERROR })
  @ApiResponse({
    status: 409,
    description: 'Video is not a draft',
    schema: ERROR,
  })
  uploadedParts(
    @CurrentUser() user: JwtPayload,
    @Param('slug') slug: string,
  ): Promise<UploadedPartsResponseDto> {
    return this.videosService.listUploadedParts(user.sub, slug);
  }

  @Post(':slug/upload/complete')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Complete an upload and start processing',
    description:
      'Completes the multipart upload, sets the video to processing and enqueues it for the worker. Idempotent while processing.',
  })
  @ApiResponse({
    status: 202,
    description: 'Processing started',
    type: VideoSummaryDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid body or parts rejected by the storage',
    schema: ERROR,
  })
  @ApiResponse({ status: 404, description: 'Video not found', schema: ERROR })
  @ApiResponse({
    status: 409,
    description: 'Video is ready or failed',
    schema: ERROR,
  })
  complete(
    @CurrentUser() user: JwtPayload,
    @Param('slug') slug: string,
    @Body() dto: CompleteUploadDto,
  ): Promise<VideoSummaryDto> {
    return this.videosService.completeUpload(user.sub, slug, dto.parts);
  }

  @Delete(':slug/upload')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Cancel an upload',
    description: 'Aborts the multipart upload and removes the draft video.',
  })
  @ApiResponse({ status: 204, description: 'Upload cancelled' })
  @ApiResponse({ status: 404, description: 'Video not found', schema: ERROR })
  @ApiResponse({
    status: 409,
    description: 'Video is not a draft',
    schema: ERROR,
  })
  abort(
    @CurrentUser() user: JwtPayload,
    @Param('slug') slug: string,
  ): Promise<void> {
    return this.videosService.abortUpload(user.sub, slug);
  }
}
