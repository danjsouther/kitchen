import {
  IsEmail,
  IsNotEmpty,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class RegisterDto {
  @IsEmail({}, { message: 'Enter a valid email address.' })
  @MaxLength(255)
  email!: string;

  // 12 characters with no composition rules: length is what actually resists
  // guessing, and character-class rules mostly push people toward "Passw0rd!".
  @IsString()
  @MinLength(12, { message: 'Use at least 12 characters.' })
  @MaxLength(200)
  password!: string;

  @IsString()
  @IsNotEmpty({ message: 'Enter your name.' })
  @MaxLength(100)
  displayName!: string;

  @IsString()
  @IsNotEmpty({ message: 'Name your household.' })
  @MaxLength(100)
  householdName!: string;
}

export class LoginDto {
  @IsEmail({}, { message: 'Enter a valid email address.' })
  email!: string;

  @IsString()
  @IsNotEmpty()
  password!: string;
}

export class ForgotPasswordDto {
  @IsEmail({}, { message: 'Enter a valid email address.' })
  @MaxLength(255)
  email!: string;
}

export class ResetPasswordDto {
  @IsString()
  @IsNotEmpty({ message: 'Reset link is missing its token.' })
  token!: string;

  @IsString()
  @MinLength(12, { message: 'Use at least 12 characters.' })
  @MaxLength(200)
  newPassword!: string;
}
