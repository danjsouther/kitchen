import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule, type JwtModuleOptions } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';

import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './strategies/jwt.strategy';

@Module({
  imports: [
    PassportModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const secret = config.get<string>('JWT_SECRET');
        if (!secret) {
          // Refuse to boot rather than sign sessions with a default: a
          // predictable secret means anyone can mint a valid token.
          throw new Error(
            'JWT_SECRET is not set. Generate one with: ' +
              'node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64\'))"',
          );
        }
        // `expiresIn` is typed as the `ms` package's template-literal union, which
        // a config string cannot satisfy statically — the value is validated by
        // jsonwebtoken at signing time instead.
        return {
          secret,
          signOptions: { expiresIn: config.get<string>('JWT_EXPIRES_IN') ?? '7d' },
        } as JwtModuleOptions;
      },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy],
  exports: [AuthService],
})
export class AuthModule {}
