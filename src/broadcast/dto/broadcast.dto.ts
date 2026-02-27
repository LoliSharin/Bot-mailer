import { IsArray, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class BroadcastDto {
  @IsOptional()
  @IsString()
  segment?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  chatIds?: string[];

  @IsString()
  @IsNotEmpty()
  message!: string;
}
