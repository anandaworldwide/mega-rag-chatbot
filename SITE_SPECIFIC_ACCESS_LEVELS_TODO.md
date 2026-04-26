# Site-Specific Access Levels Implementation Plan

## Overview

This document outlines the implementation plan for a comprehensive site-specific access level system across the Ananda
Library Chatbot monorepo. The system will replace the current exclusion-based access control with an inclusion-based
model where each site can define its own access hierarchy.

## Current Implementation Notes

The implemented access-control model uses `web/site-config/config.json` `accessControl` settings rather than the
earlier draft `accessLevels` object shown below. Each configured level has a `key`, display `label`, and numeric
`value`; users can retrieve content where their effective access level is greater than or equal to the vector's
`required_access_level`.

User access is resolved in this order:

1. `superuser` role receives the configured `superuserLevel`.
2. A valid Salesforce match can provide `salesforceAccessLevel`.
3. Admin-managed `manualAccessLevel` applies when Salesforce has not matched.
4. The site's `defaultLevel` applies as the fallback.

Pinecone vectors now carry both legacy `access_level` string metadata and numeric `required_access_level` metadata.
New ingestion should treat required access as explicit source data: audio/video uses a command-line
`--required-access-level`, SQL/database ingestion can read a named source column via `--required-access-level-field`,
and public/default sources write `required_access_level: 0`.

Salesforce integration is optional and site-config gated. When configured with
`SALESFORCE_ACCESS_LOOKUP_WEBHOOK_URL`, admins can manually sync a user, and the scheduled
`/api/cron/syncUserAccessLevels` job refreshes due accepted users in bounded batches.

## Requirements

### Core Requirements

- **Site-Specific Configuration**: Each site defines its own access levels, names, and permissions
- **Inclusion-Based Filtering**: Users can access content where `user.accessLevel >= content.accessLevel`
- **Admin Permission Controls**: Regular admins limited to certain levels, superusers have full access
- **SalesForce Integration**: Automatic access level synchronization for authenticated users
- **Backward Compatibility**: Graceful degradation for existing content and users

### Access Level Structure

Each site defines access levels with:

- **Level numbers**: 0-500 (higher = more restricted)
- **Display names**: User-friendly names for admin interfaces
- **Descriptions**: Optional explanations for each level
- **Permission flags**: `superuserOnly` for restricted levels

### Example Access Levels

```json
{
  "-1": { "name": "Banned", "description": "User is banned" },
  "0": { "name": "Public", "description": "Basic devotee access" },
  "100": { "name": "Disciples", "description": "Disciple-level content" },
  "200": { "name": "Kriyabans", "description": "Kriyaban teachings" },
  "300": { "name": "Library Access", "description": "Full library access" },
  "400": { "name": "Ministers", "description": "Minister content" },
  "500": { "name": "Private", "description": "Per-user content", "superuserOnly": true }
}
```

## Current State Analysis

### Existing Components

- **Exclusion-based filtering**: `excludedAccessLevels` and `accessLevelPathMap`
- **Pinecone metadata**: Content has `access_level` field
- **Basic user management**: Firestore users collection with role-based access
- **Site configuration**: JSON-based site configs with some access level fields

### Limitations

- Hardwired logic for specific levels (kriyaban exclusion)
- No user-level access control
- Site configs can't define custom hierarchies
- Admin interfaces don't support level management

## Architecture Changes

### 1. Site Configuration (`site-config/`)

#### Files to Modify

- `config.json`: Add access level definitions to each site
- `config.json` (all sites): Replace `excludedAccessLevels` and `accessLevelPathMap`

#### New Configuration Structure

```json
{
  "accessLevels": {
    "level_number": {
      "name": "Display Name",
      "description": "Optional description",
      "superuserOnly": false
    }
  },
  "defaultUserAccessLevel": 0,
  "adminMaxAccessLevel": 200
}
```

### 2. Web Frontend (`web/`)

#### TypeScript Interfaces (`web/src/types/`)

- `siteConfig.ts`: Add access level configuration types
- `user.ts`: Add `accessLevel?: number` field

#### API Endpoints (`web/src/app/api/`, `web/src/pages/api/`)

- `/api/chat/v1/route.ts`: Update content filtering logic
- `/api/admin/users/`: Add access level management endpoints
- `/api/admin/updateUserAccessLevel`: New SalesForce webhook endpoint
- `/api/profile`: Update user profile with access level

#### Components (`web/src/components/`)

- `AddUsersModal.tsx`: Add access level dropdown
- `AdminUsersPage`: Update user management interface
- User detail pages: Show/manage access levels

#### Utilities (`web/src/utils/`)

- `server/accessLevelUtils.ts`: New utility functions for access control
- `server/siteConfigUtils.ts`: Update site config loading
- `client/tokenManager.ts`: Update user context with access level

### 3. Data Ingestion (`data_ingestion/`)

#### Python Scripts

- `pdf_to_vector_db.py`: Update to handle access level metadata
- All ingestion scripts: Support `access_level` field in Pinecone metadata

#### Utilities (`data_ingestion/utils/`)

- `metadata_utils.py`: New functions for access level processing
- Update existing metadata processing to include access levels

#### Tests (`data_ingestion/tests/`)

- Add tests for access level processing
- Update existing tests for new metadata structure

### 4. Python Utilities (`pyutil/`)

#### Core Utilities

- `site_config_utils.py`: Update to handle access level configuration
- Add validation functions for access level data

### 5. Testing (`__tests__/`, `web/__tests__/`, `data_ingestion/tests/`)

#### New Test Coverage

- Access level validation and utilities
- Site-specific configuration loading
- Admin permission checks
- Content filtering with access levels
- SalesForce webhook integration

### 6. Documentation (`docs/`)

#### New Documentation

- `ACCESS_LEVELS_GUIDE.md`: Complete guide for configuring access levels
- Update `backend-structure.md`: Document new API endpoints
- Update `data-ingestion.md`: Document access level processing
- Update `frontend-guidelines.md`: Admin interface patterns

## Implementation Phases

### Phase 1: Access Level Management (Admin & User Data)

**Goal**: Enable administrators to set access levels for users while keeping existing content filtering unchanged.

1. **Core Infrastructure Setup**

   - Update TypeScript interfaces (`siteConfig.ts`, `user.ts`) to include access level fields
   - Add access level definitions to all site configurations
   - Create access level utility functions for validation and permission checking
   - Update site config loading and validation logic

2. **User Data Model Updates**

   - Add `accessLevel?: number` field to User interface
   - Update Firestore user collection schema
   - Add default access level assignment (0 = public) for new users
   - Create database migration for existing users

3. **Admin Interface Updates**

   - Update user management pages with access level dropdowns
   - Add permission checks (regular admins limited to `adminMaxAccessLevel`, superusers unlimited)
   - Create access level management utilities and API endpoints
   - Update `AddUsersModal.tsx` and user detail pages

4. **Testing & Validation**
   - Unit tests for access level utilities and validation
   - Integration tests for admin interfaces
   - Database migration testing
   - Backward compatibility verification

**Result**: Administrators can set access levels for users, but content filtering remains unchanged (existing
exclusion-based system continues working).

### Phase 2: Content Filtering & SalesForce Integration

**Goal**: Implement user-based content filtering and SalesForce synchronization when the SalesForce API is available and
content has access levels.

**Prerequisites**: SalesForce API access available, content in Ananda Library has access level metadata assigned.

1. **Content Filtering Implementation**

   - Update Pinecone filtering logic from exclusion (`$nin`) to inclusion (`$lte`)
   - Modify chat API (`/api/chat/v1/route.ts`) to use user access levels
   - Update data ingestion scripts to handle access level metadata properly
   - Test content filtering with various access level combinations

2. **SalesForce Integration**

   - Implement access level synchronization logic:
     - First access: Check SalesForce immediately when logged-in user visits site
     - 24-hour refresh: Re-check user status with SalesForce once per day during usage
     - Async refresh: Update access_level asynchronously on page loads if stale
   - Create webhook endpoint `/api/admin/updateUserAccessLevel` for SalesForce-initiated updates
   - Add authentication and validation for SalesForce API calls
   - Implement user access level updates with proper caching and error handling
   - Add comprehensive audit logging for all access level changes

3. **Full System Testing**

   - End-to-end content filtering tests with user access levels
   - SalesForce integration testing (mocked in development)
   - Performance testing for content filtering queries
   - User acceptance testing with real access level scenarios

4. **Production Deployment**
   - Data migration for existing users and content
   - Gradual rollout with feature flags
   - Monitoring and rollback procedures
   - Production deployment and validation

## Migration Strategy

### User Data Migration

- Add `accessLevel` field to existing users (default to 0)
- Run database migration script to set appropriate levels for existing users
- Update user creation logic to set default levels

### Content Migration

- Existing content with `access_level` metadata: Map to new system
- Content without access levels: Default to public (0) or site-specific default
- Update ingestion scripts to handle both old and new metadata formats

### Configuration Migration

- Convert existing `excludedAccessLevels` to new access level definitions
- Update all site configurations with new structure
- Maintain backward compatibility during transition

## Testing Approach

### Unit Tests

- Access level utility functions
- Site configuration validation
- Permission checking logic
- API endpoint validation

### Integration Tests

- End-to-end content filtering
- Admin user management workflows
- WordPress content creation with access levels
- SalesForce webhook processing

### Performance Tests

- Content filtering query performance
- Large-scale user access level updates
- Memory usage with access level caching

### Security Tests

- Permission escalation attempts
- Unauthorized access level assignments
- Webhook authentication validation

## Rollback Plan

### Quick Rollback (Immediate)

1. Feature flag to disable access level filtering
2. Revert to exclusion-based filtering
3. Restore original admin interfaces

### Full Rollback (If Needed)

1. Database migration to remove access level fields
2. Revert site configurations
3. Restore original code versions
4. Clear access level metadata from Pinecone

### Monitoring During Rollout

- Error rates and performance metrics
- User access patterns and complaints
- Admin feedback on interface changes
- Content accessibility validation

## Success Metrics

### Technical Metrics

- Query performance within 10% of baseline
- Zero security vulnerabilities in access control
- 100% test coverage for access level logic
- <1% error rate in access level assignments

### User Experience Metrics

- Admin interface usability scores >4/5
- Content accessibility matches business requirements
- No user complaints about content access issues
- SalesForce integration processes updates within 5 minutes

### Business Metrics

- Successful implementation of access level restrictions
- Admin efficiency in managing user access
- Content creator ability to set appropriate access levels
- Audit trail completeness for access level changes

## Risk Assessment

### High Risk

- Database migration could corrupt user data (Phase 1)
- Content filtering logic errors could block legitimate access (Phase 2)
- Performance degradation from access level queries (Phase 2)

### Medium Risk

- Admin interface complexity could reduce efficiency (Phase 1)
- SalesForce webhook could fail silently (Phase 2)
- Access level synchronization timing issues (Phase 2)

### Mitigation Strategies

- **Phase 1**: Test admin interfaces thoroughly before deployment, gradual rollout of user management features
- **Phase 2**: Comprehensive end-to-end testing, feature flags for content filtering, monitoring of SalesForce
  integration
- User communication about access level changes
- Quick rollback procedures for each phase

## Dependencies

### External Dependencies

- **Phase 1**: None - all infrastructure is internal
- **Phase 2**: SalesForce webhook API availability, Pinecone metadata field updates for content

### Internal Dependencies

- **Phase 1**: Site configuration updates, database schema changes, admin interface updates
- **Phase 2**: Content filtering logic updates, SalesForce integration development

### Team Dependencies

- **Phase 1**: Admins trained on user management changes, developers for admin interface updates
- **Phase 2**: Content creators trained on access level system, SalesForce API integration team, developers for content
  filtering

## Conclusion

This implementation provides a flexible, site-specific access level system that can evolve with each site's needs while
maintaining security and performance. The phased approach minimizes risk and allows for thorough testing at each stage.

The system design prioritizes:

- **Flexibility**: Each site defines its own access hierarchy
- **Security**: Proper permission controls and audit trails
- **Usability**: Intuitive admin interfaces with clear naming
- **Performance**: Efficient database queries and caching
- **Maintainability**: Clean separation of concerns and comprehensive testing
